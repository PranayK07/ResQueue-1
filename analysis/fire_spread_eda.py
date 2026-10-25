#!/usr/bin/env python3
"""NIROPS fire-spread EDA helpers for Wildfire Rescue Queue (Cal Hacks 13.0).

Used by analysis/nirops_eda.ipynb. Also runs on its own:
    python analysis/fire_spread_eda.py --state CA [--fire dixie]

The data never goes in git (analysis/data/ is gitignored). find_data() looks for the
Mendeley zip on your machine (NIROPS_ZIP env var, analysis/data/, ~/Downloads); if it
isn't there, download_vector() pulls only the 1.4 GB shapefile zip from Mendeley.
The first run streams it into a small simplified GeoParquet cache; later runs take seconds.

Data (credit it on screen, CC BY 4.0): Magstadt, O'Connor et al., "A high spatial
resolution daily fire perimeter progression dataset for wildfires in the Western
United States: 2020-2024", Mendeley Data v1, doi:10.17632/95rj5d379g.1
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
import time
import zipfile
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
DATA_DIR = HERE / "data"
OUT_DIR = HERE / "outputs"
CACHE = DATA_DIR / "nirops_simplified.parquet"

VECTOR_NAME = "NIROPS_2020_2024_R1_R6.zip"   # the shapefile part of the Mendeley dataset
VECTOR_URL = ("https://data.mendeley.com/public-files/datasets/95rj5d379g/files/"
              "e9caf5e3-dcd1-4633-98a9-7f857d110b29/file_downloaded")
VECTOR_BYTES = 1_387_524_228

OAKLAND_1991_ACRES = 1520     # 1991 Oakland Hills firestorm, total area burned (Wikipedia)
FIELD_ACRES = 1.32            # one US football field incl. end zones (57,600 sq ft)
NIGHT_SHIFT_H = 14            # NIROPS flies at night; shift UTC so one flight night = one date
BERKELEY_LONLAT = (-122.2727, 37.8716)

SURFACE, INK, INK2, RULE = "#1a1a19", "#f0efec", "#c3c2b7", "#383835"
FIRE = "#d95926"                                                # bars, 3:1+ on SURFACE
RAMP = ["#8a3a14", "#b0481d", "#d95926", "#f08a4b", "#ffc49a"]  # oldest -> newest, validated
CREDIT = ("Data: NIROPS daily fire perimeters, Western US 2020-2024 (Magstadt, O'Connor et al., "
          "Mendeley Data, doi:10.17632/95rj5d379g.1, CC BY 4.0)")
VECTOR_EXTS = (".shp", ".gpkg", ".geojson", ".fgb")


# ---------- getting the data (never into git) ----------

def find_data() -> Path | None:
    """The Mendeley zip on this machine: the full 1.7 GB download or just the 1.4 GB shapefile zip."""
    dl = Path.home() / "Downloads"
    cands = []
    if os.environ.get("NIROPS_ZIP"):
        cands.append(Path(os.environ["NIROPS_ZIP"]).expanduser())
    cands.append(DATA_DIR / VECTOR_NAME)
    cands += sorted(DATA_DIR.glob("*.zip"), key=lambda p: p.stat().st_size, reverse=True)
    cands.append(dl / VECTOR_NAME)
    cands += sorted(dl.glob("*fire perimeter*.zip")) + sorted(dl.glob("*NIROPS*.zip"))
    for c in cands:
        if c.is_file() and zipfile.is_zipfile(c):
            return c
    return None


def download_vector(dest: Path = DATA_DIR / VECTOR_NAME) -> Path:
    """Download only the shapefile zip (1.4 GB) from Mendeley into analysis/data/."""
    import urllib.request
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_suffix(".part")
    print(f"Downloading {VECTOR_NAME} (1.4 GB) from Mendeley Data into {dest.parent} ...")
    req = urllib.request.Request(VECTOR_URL, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req) as r, open(part, "wb") as f:
        total, done, next_print = int(r.headers.get("Content-Length") or VECTOR_BYTES), 0, 0
        while chunk := r.read(1 << 20):
            f.write(chunk)
            done += len(chunk)
            if done >= next_print:
                print(f"  {done / 1e9:.2f} / {total / 1e9:.2f} GB", end="\r")
                next_print += 50 << 20
    part.rename(dest)
    print(f"\nSaved {dest}")
    return dest


def ensure_vector_zip(zp: Path) -> Path:
    """If zp is the full Mendeley download, pull out only the shapefile zip (once)."""
    with zipfile.ZipFile(zp) as z:
        names = z.namelist()
        if any(n.lower().endswith(VECTOR_EXTS) for n in names):
            return zp                                    # already the shapefile zip
        inner = [i for i in z.infolist() if i.filename.lower().endswith(".zip")]
        pick_ = [i for i in inner if "NIROPS_2020" in i.filename] or sorted(inner, key=lambda i: -i.file_size)
        if not pick_:
            raise FileNotFoundError(f"No shapefile or inner zip inside {zp.name}. Members: {names[:20]}")
        member = pick_[0]
        dest = DATA_DIR / Path(member.filename).name
        if dest.exists() and dest.stat().st_size == member.file_size:
            return dest
        free = shutil.disk_usage(DATA_DIR if DATA_DIR.exists() else HERE).free
        if free < member.file_size * 1.2:
            raise OSError(f"Need {member.file_size / 1e9:.1f} GB free to unpack {member.filename}; "
                          f"only {free / 1e9:.1f} GB free.")
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        print(f"Copying {member.filename} ({member.file_size / 1e9:.2f} GB) out of {zp.name} "
              "(only this file; nothing else is unpacked or run) ...")
        with z.open(member) as src, open(dest, "wb") as out:
            shutil.copyfileobj(src, out, length=8 << 20)
        return dest


def vector_sources(vector_zip: Path) -> list[str]:
    """GDAL paths to every vector file inside the shapefile zip (read in place, not unpacked)."""
    with zipfile.ZipFile(vector_zip) as z:
        hits = [i.filename for i in z.infolist()
                if i.filename.lower().endswith(VECTOR_EXTS) and not Path(i.filename).name.startswith("._")]
    if not hits:
        raise FileNotFoundError(f"No .shp/.gpkg inside {vector_zip.name}")
    return [f"/vsizip/{{{vector_zip.resolve()}}}/{h}" for h in hits]


def build_cache(sources: list[str], out: Path = CACHE, simplify_m: float = 30, batch_size: int = 500) -> Path:
    """Stream every perimeter once, simplify to ~30 m (invisible at map scale), save as GeoParquet."""
    import geopandas as gpd
    import pyogrio
    out.parent.mkdir(parents=True, exist_ok=True)
    parts, t0 = [], time.time()

    def add(g):
        g = g.set_crs(4326, allow_override=False) if g.crs is None else g
        g = g.to_crs(5070)
        g["geometry"] = g.geometry.make_valid().simplify(simplify_m)
        parts.append(g)
        print(f"  {sum(len(p) for p in parts):,} perimeters cached ({time.time() - t0:.0f} s)", end="\r")

    for src in sources:
        try:
            with pyogrio.open_arrow(src, batch_size=batch_size, use_pyarrow=True) as (meta, reader):
                gcol = meta.get("geometry_name") or "wkb_geometry"
                crs = meta.get("crs") or "EPSG:4326"
                for batch in reader:
                    df = batch.to_pandas()
                    geom = gpd.GeoSeries.from_wkb(df.pop(gcol), crs=crs)
                    add(gpd.GeoDataFrame(df, geometry=geom))
        except Exception as e:                         # older pyogrio/GDAL: read in one go
            print(f"\nStreaming read failed ({e}); reading {src} in one go ...")
            add(pyogrio.read_dataframe(src))
    gdf = gpd.GeoDataFrame(pd.concat(parts, ignore_index=True), geometry="geometry", crs=5070)
    gdf.to_parquet(out)
    print(f"\nCached {len(gdf):,} perimeters to {out} ({out.stat().st_size / 1e6:.0f} MB) "
          f"in {time.time() - t0:.0f} s")
    return out


# ---------- columns and time ----------

def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", str(s).lower())


def pick(df, override, candidates, contains=()):
    if override:
        if override not in df.columns:
            raise KeyError(f"Column {override!r} not found. Columns: {list(df.columns)}")
        return override
    by_norm = {_norm(c): c for c in df.columns}
    for c in candidates:
        if _norm(c) in by_norm:
            return by_norm[_norm(c)]
    for c in df.columns:
        if any(k in _norm(c) for k in contains):
            return c
    return None


def detect_columns(df, overrides: dict | None = None) -> dict:
    o = overrides or {}
    cols = {
        "name": pick(df, o.get("name"), ["Inc Name", "IncName", "IncidentName", "FireName", "Name"], ("name",)),
        "id": pick(df, o.get("id"), ["IRWINID", "IRWIN_ID"], ("irwin",)),
        "number": pick(df, o.get("number"), ["Inc Number", "IncNumber", "IncidentNumber"], ("number",)),
        "comp": pick(df, o.get("comp"), ["Incident_C", "IncidentCode", "Incident_Code"], ("incident",)),
        "acres": pick(df, o.get("acres"), ["Acres", "GISAcres", "GIS_ACRES"], ("acre",)),
        "date": pick(df, o.get("date"), ["DateUTC", "Date_UTC", "AcqDate", "Date"], ("date",)),
        "utc": pick(df, o.get("utc"), ["UTC", "TimeUTC", "Time"], ("time",)),
    }
    if not cols["acres"]:
        raise KeyError("No acres column found; pass overrides={'acres': '<column>'}")
    return cols


def parse_time(df, date_col, utc_col):
    """Return (UTC timestamps, how they were built)."""
    if date_col:
        d = pd.to_datetime(df[date_col], errors="coerce", utc=True)
        ok = d.dropna()
        if len(ok) and ((ok.dt.hour != 0) | (ok.dt.minute != 0)).mean() > 0.2:
            return d, f"{date_col} (has time of day)"
    if utc_col and utc_col != date_col:
        s = df[utc_col]
        if pd.api.types.is_numeric_dtype(s):
            s = s.round().astype("Int64").astype(str)
        s = s.astype(str).str.strip()
        if date_col and s.str.fullmatch(r"\d{1,2}:?\d{2}(:\d{2})?").mean() > 0.8:
            digits = s.str.replace(":", "", regex=False).str.zfill(4)
            hh = pd.to_numeric(digits.str[:2], errors="coerce")
            mm = pd.to_numeric(digits.str[2:4], errors="coerce")
            base = pd.to_datetime(df[date_col], errors="coerce", utc=True).dt.normalize()
            return (base + pd.to_timedelta(hh, unit="h") + pd.to_timedelta(mm, unit="m"),
                    f"{date_col} + {utc_col} (HHMM)")
        full = pd.to_datetime(s, errors="coerce", utc=True)
        if full.notna().mean() > 0.8:
            return full, f"{utc_col} (full timestamp)"
    if date_col:
        return pd.to_datetime(df[date_col], errors="coerce", utc=True), f"{date_col} (date only, 00:00 UTC)"
    raise KeyError("Could not find a date/time column; pass overrides={'date': '<column>'}")


def state_of(*vals):
    for v in vals:
        m = re.match(r"^([A-Z]{2})-", str(v))
        if m:
            return m.group(1)
    return "?"


def pretty(name: str) -> str:
    """DIXIE -> Dixie, SCU LIGHTNING COMPLEX -> SCU Lightning Complex (keeps short acronyms)."""
    name = re.sub(r"[_]+", " ", str(name)).strip()
    if not (name.isupper() or name.islower()):
        return name
    return " ".join(w if (w.isupper() and len(w) <= 3 and w not in {"OF", "THE", "AND"}) else w.title()
                    for w in name.split())


def build_work(df: pd.DataFrame, cols: dict) -> tuple[pd.DataFrame, str]:
    """One clean row per source perimeter: inc (fire id), comp, name, state, acres, t, night."""
    t, how = parse_time(df, cols["date"], cols["utc"])
    key_cols = [c for c in (cols["id"], cols["number"], cols["comp"], cols["name"]) if c]
    inc = df[key_cols[0]].astype("string")
    for c in key_cols[1:]:
        inc = inc.fillna(df[c].astype("string"))
    work = pd.DataFrame({
        "inc": inc,
        "comp": df[cols["comp"]].astype("string") if cols["comp"] else inc,
        "name": df[cols["name"]].astype("string") if cols["name"] else inc,
        "acres": pd.to_numeric(df[cols["acres"]], errors="coerce"),
        "t": t,
    }, index=df.index)
    blank = pd.Series([""] * len(df), index=df.index)
    work["state"] = [state_of(*v) for v in zip(df[cols["comp"]] if cols["comp"] else blank,
                                               df[cols["number"]] if cols["number"] else blank)]
    work["night"] = (work["t"] - pd.Timedelta(hours=NIGHT_SHIFT_H)).dt.floor("D")
    work = work.dropna(subset=["inc", "acres", "t"])
    return work[work["acres"] > 0], how


# ---------- core numbers ----------

def nightly_growth(work: pd.DataFrame) -> pd.DataFrame:
    """One row per fire per nightly map: cumulative acres and growth since the previous map."""
    g = (work.groupby(["inc", "comp", "night"], as_index=False)
             .agg(acres=("acres", "max"), t=("t", "median")))
    out = []
    for inc, sub in g.groupby("inc", sort=False):
        pv = sub.pivot_table(index="night", columns="comp", values="acres", aggfunc="max").sort_index()
        pv = pv.ffill().cummax()          # a footprint never shrinks; carry unmapped parts forward
        total = pv.sum(axis=1)
        t = sub.groupby("night")["t"].median().reindex(total.index)
        part = pd.DataFrame({"inc": inc, "night": total.index, "t": t.values, "acres": total.values})
        part["growth"] = part["acres"].diff()
        part["hours"] = part["t"].diff().dt.total_seconds() / 3600
        part["gap_nights"] = part["night"].diff().dt.days
        out.append(part)
    res = pd.concat(out, ignore_index=True)
    meta = work.groupby("inc").agg(name=("name", lambda s: s.mode().iat[0] if s.notna().any() else "?"),
                                   state=("state", lambda s: s.mode().iat[0]))
    res = res.join(meta, on="inc")
    # "one day" = two consecutive nightly maps, 12 to 36 hours apart
    res["one_night"] = (res["gap_nights"] == 1) & res["hours"].between(12, 36) & (res["growth"] >= 0)
    res["fields_per_min"] = res["growth"] / FIELD_ACRES / (res["hours"] * 60)
    return res


def _row(r) -> dict:
    return {"fire": pretty(r["name"]), "state": r["state"], "night_of": str(r["night"].date()),
            "acres_added": int(round(r["growth"])), "hours_between_maps": round(float(r["hours"]), 1),
            "football_fields_per_min": round(float(r["fields_per_min"]), 1),
            "x_oakland_1991": round(float(r["growth"]) / OAKLAND_1991_ACRES, 1)}


def headline(n: pd.DataFrame, scope: str) -> dict:
    one = n[n["one_night"]]
    if one.empty:
        return {"scope": scope, "one_day_intervals": 0}
    big = one[one["growth"] > OAKLAND_1991_ACRES]
    top = one.sort_values("growth", ascending=False).drop_duplicates("inc").head(10)
    return {
        "scope": scope,
        "fires": int(n["inc"].nunique()),
        "one_day_intervals": int(len(one)),
        "median_one_day_growth_acres": int(round(one["growth"].median())),
        "p90_one_day_growth_acres": int(round(one["growth"].quantile(0.9))),
        "days_bigger_than_oakland_1991": int(len(big)),
        "share_days_bigger_than_oakland_1991_pct": round(100 * len(big) / len(one), 1),
        "fires_with_at_least_one_such_day": int(big["inc"].nunique()),
        "biggest_one_day_jump": _row(one.loc[one["growth"].idxmax()]),
        "fastest_spread": _row(one.loc[one["fields_per_min"].idxmax()]),
        "top10": [_row(r) for _, r in top.iterrows()],
    }


# ---------- charts (1920x1080, dark, for the video) ----------

def _fig():
    import matplotlib
    import matplotlib.pyplot as plt
    if "inline" not in matplotlib.get_backend().lower() and not os.environ.get("DISPLAY"):
        matplotlib.use("Agg")
    plt.rcParams.update({"font.family": "DejaVu Sans", "text.color": INK, "axes.labelcolor": INK2,
                         "xtick.color": INK2, "ytick.color": INK2, "axes.edgecolor": RULE})
    return plt, plt.figure(figsize=(19.2, 10.8), dpi=100, facecolor=SURFACE)


def _credit(fig, extra=""):
    fig.text(0.04, 0.03, CREDIT + (f"\n{extra}" if extra else ""), color=INK2, fontsize=13,
             ha="left", va="bottom", linespacing=1.5)


def _k(x: float) -> str:
    return f"{x / 1000:.0f}K" if x >= 10_000 else f"{x:,.0f}"


def chart_top10(h: dict, out: Path) -> Path:
    plt, fig = _fig()
    top = h["top10"][::-1]
    ax = fig.add_axes([0.25, 0.16, 0.66, 0.64], facecolor=SURFACE)
    y = np.arange(len(top))
    vals = [r["acres_added"] for r in top]
    ax.barh(y, vals, height=0.62, color=FIRE)
    ax.set_yticks(y, [f"{r['fire']} ({r['state']})  ·  {pd.Timestamp(r['night_of']):%b %Y}" for r in top],
                  fontsize=17, color=INK)
    xmax = max(vals)
    for yi, r in zip(y, top):
        ax.text(r["acres_added"] + xmax * 0.012, yi,
                f"{_k(r['acres_added'])} acres  ·  {r['x_oakland_1991']:.0f}x Oakland 1991",
                va="center", ha="left", fontsize=15, color=INK2)
    ax.set_xlim(0, xmax * 1.42)
    ax.set_xticks([])
    for s in ("top", "right", "bottom"):
        ax.spines[s].set_visible(False)
    ax.tick_params(axis="y", length=0, pad=12)
    scope = "California" if h["scope"] == "CA" else "Western US"
    fig.text(0.04, 0.90, f"Biggest one-day growth, {scope} wildfires 2020-2024", fontsize=38,
             weight="bold", color=INK)
    fig.text(0.04, 0.85, "Acres added between two nightly infrared maps (about a day apart), one bar per fire. "
             f"The whole 1991 Oakland Hills fire burned {OAKLAND_1991_ACRES:,} acres.", fontsize=18, color=INK2)
    _credit(fig, "Oakland 1991 area: Wikipedia, Oakland firestorm of 1991.")
    fig.savefig(out, facecolor=SURFACE)
    plt.close(fig)
    return out


def hero(value: str, line: str, sub: str, out: Path, extra_credit: str = "") -> Path:
    plt, fig = _fig()
    fig.text(0.5, 0.60, value, fontsize=190, weight="bold", color=INK, ha="center", va="center")
    fig.text(0.5, 0.40, line, fontsize=40, color=INK, ha="center", va="center")
    fig.text(0.5, 0.32, sub, fontsize=22, color=INK2, ha="center", va="center")
    fig.add_artist(plt.Line2D([0.44, 0.56], [0.48, 0.48], color=FIRE, lw=6, solid_capstyle="round"))
    _credit(fig, extra_credit)
    fig.savefig(out, facecolor=SURFACE)
    plt.close(fig)
    return out


def hero_cards(h: dict, out_dir: Path) -> list[Path]:
    where = "California" if h["scope"] == "CA" else "Western US"
    pct = h["share_days_bigger_than_oakland_1991_pct"]
    f = h["fastest_spread"]
    return [
        hero(f"{pct:.0f}%" if pct >= 1 else f"{pct:.1f}%",
             "of fire-days, a fire grew more than the entire 1991 Oakland Hills fire",
             f"{h['days_bigger_than_oakland_1991']:,} of {h['one_day_intervals']:,} fire-days, {where} 2020-2024 "
             f"({OAKLAND_1991_ACRES:,}+ acres added between two nightly maps)",
             out_dir / "hero_oakland.png", "Oakland 1991 area: Wikipedia, Oakland firestorm of 1991."),
        hero(f"{f['football_fields_per_min']:.0f}",
             f"football fields a minute, for {f['hours_between_maps']:.0f} hours straight",
             f"{f['fire']} Fire ({f['state']}), {pd.Timestamp(f['night_of']):%b %d, %Y}: "
             f"{f['acres_added']:,} acres between two nightly maps",
             out_dir / "hero_speed.png", "Average over the time between maps. 1 football field = 1.32 acres."),
    ]


# ---------- one fire, map by map ----------

def frames_from_gdf(g) -> list:
    """Cumulative footprint per nightly map. g needs 'night' and geometry in EPSG:5070."""
    from shapely.ops import unary_union
    g = g.dropna(subset=["night"])
    g = g.to_crs(5070) if g.crs is not None and g.crs.to_epsg() != 5070 else g
    frames, cum = [], None
    for night, part in g.groupby("night"):
        geoms = [x for x in part.geometry if x is not None and not x.is_empty]
        if not geoms:
            continue
        cum = unary_union(([cum] if cum is not None else []) + geoms)
        frames.append((night, cum))
    return frames


def front_runs(frames, touch_m: float = 1000, max_points: int = 3000) -> list[dict]:
    """How far the fire edge moved between consecutive maps: the farthest new burned point
    from the previous footprint, counting only growth attached to it (skips new spot fires)."""
    import shapely
    runs = []
    for (n0, a), (n1, b) in zip(frames, frames[1:]):
        new = b.difference(a)
        parts = [p for p in getattr(new, "geoms", [new]) if not p.is_empty and p.distance(a) <= touch_m]
        km = 0.0
        if parts:
            xy = np.vstack([shapely.get_coordinates(p) for p in parts])
            if len(xy) > max_points:                      # keep it fast on huge fires
                xy = xy[np.linspace(0, len(xy) - 1, max_points).astype(int)]
            km = float(shapely.distance(shapely.points(xy), a).max()) / 1000
        runs.append({"night": n1, "gap_days": int((n1 - n0).days), "front_km": round(km, 1)})
    return runs


def chart_timelapse(frames, name, state, acres_by_night: pd.Series, out_png: Path, out_anim: Path,
                    fps: int = 3) -> Path:
    import matplotlib.animation as animation
    from matplotlib.colors import LinearSegmentedColormap
    import geopandas as gpd

    cmap = LinearSegmentedColormap.from_list("fire", RAMP)
    n = len(frames)
    x0, y0, x1, y1 = gpd.GeoSeries([frames[-1][1]], crs=5070).total_bounds
    pad = 0.08 * max(x1 - x0, y1 - y0)
    final_acres = float(acres_by_night.iloc[-1]) if len(acres_by_night) else float("nan")
    title = f"The {name} Fire ({state}), map by map"
    sub = (f"{n} nightly infrared maps, {frames[0][0]:%b %d} to {frames[-1][0]:%b %d, %Y}. "
           f"Final size {final_acres:,.0f} acres, {final_acres / OAKLAND_1991_ACRES:.0f}x the 1991 Oakland Hills fire.")
    bar_km = 10 if (x1 - x0) > 25_000 else 2

    def setup():
        plt, fig = _fig()
        ax = fig.add_axes([0.04, 0.10, 0.92, 0.72], facecolor=SURFACE)
        ax.set_xlim(x0 - pad, x1 + pad); ax.set_ylim(y0 - pad, y1 + pad)
        ax.set_aspect("equal"); ax.axis("off")
        fig.text(0.04, 0.91, title, fontsize=38, weight="bold", color=INK)
        fig.text(0.04, 0.865, sub, fontsize=19, color=INK2)
        bx, by = x0 - pad * 0.5, y0 - pad * 0.6
        ax.plot([bx, bx + bar_km * 1000], [by, by], color=INK2, lw=3)
        ax.text(bx + bar_km * 500, by + pad * 0.12, f"{bar_km} km", color=INK2, fontsize=14, ha="center")
        _credit(fig)
        return plt, fig, ax

    # Static: every map as a ring, oldest dark at the center, newest bright at the edge.
    plt, fig, ax = setup()
    for i in range(n - 1, -1, -1):
        gpd.GeoSeries([frames[i][1]], crs=5070).plot(ax=ax, color=cmap(i / max(n - 1, 1)),
                                                     edgecolor=SURFACE, linewidth=0.6)
    cax = fig.add_axes([0.66, 0.80, 0.28, 0.014])
    cax.imshow(np.linspace(0, 1, 256)[None, :], aspect="auto", cmap=cmap)
    cax.set_yticks([])
    cax.set_xticks([0, 255], [f"{frames[0][0]:%b %d} (oldest)", f"{frames[-1][0]:%b %d} (newest)"],
                   fontsize=14, color=INK2)
    ticks = cax.get_xticklabels(); ticks[0].set_ha("left"); ticks[-1].set_ha("right")
    cax.tick_params(length=0)
    for s in cax.spines.values():
        s.set_visible(False)
    fig.savefig(out_png, facecolor=SURFACE)
    plt.close(fig)

    # Animated: burned so far in dark, the newest growth in bright orange.
    plt, fig, ax = setup()
    label = fig.text(0.96, 0.15, "", fontsize=30, color=INK, ha="right", weight="bold")
    label2 = fig.text(0.96, 0.11, "", fontsize=18, color=INK2, ha="right")

    def draw(i):
        for coll in list(ax.collections):
            coll.remove()
        if i > 0:
            gpd.GeoSeries([frames[i - 1][1]], crs=5070).plot(ax=ax, color=RAMP[1], edgecolor="none")
            new = frames[i][1].difference(frames[i - 1][1])
        else:
            new = frames[0][1]
        gpd.GeoSeries([new], crs=5070).plot(ax=ax, color=RAMP[4], edgecolor="none")
        night = frames[i][0]
        acres = acres_by_night.get(night, np.nan)
        label.set_text(f"{night:%b %d, %Y}   {acres:,.0f} acres")
        if i > 0 and night in acres_by_night.index:
            prev = acres_by_night.iloc[max(acres_by_night.index.get_loc(night) - 1, 0)]
            label2.set_text(f"+{max(acres - prev, 0):,.0f} acres since the last map (bright)")
        else:
            label2.set_text("first map (bright)")
        return []

    anim = animation.FuncAnimation(fig, draw, frames=n, blit=False)
    if shutil.which("ffmpeg") and out_anim.suffix == ".mp4":
        writer = animation.FFMpegWriter(fps=fps, codec="libx264",
                                        extra_args=["-pix_fmt", "yuv420p", "-preset", "veryfast", "-crf", "20"])
    else:
        out_anim = out_anim.with_suffix(".gif")
        writer = animation.PillowWriter(fps=fps)
    anim.save(out_anim, writer=writer, dpi=100, savefig_kwargs={"facecolor": SURFACE})
    plt.close(fig)
    return out_anim


def slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", s.lower()).strip("_")


# ---------- one-call pipeline (the notebook walks through the same steps) ----------

def load_all(rebuild: bool = False):
    """Find or download the data, build the cache once, return (gdf, work, nightly, how)."""
    import geopandas as gpd
    if rebuild or not CACHE.exists():
        zp = find_data() or download_vector()
        print(f"Using {zp}")
        build_cache(vector_sources(ensure_vector_zip(zp)))
    gdf = gpd.read_parquet(CACHE)
    attrs = pd.DataFrame(gdf.drop(columns=gdf.geometry.name))
    cols = detect_columns(attrs)
    work, how = build_work(attrs, cols)
    return gdf, work, nightly_growth(work), how


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--state", default="CA", help="two-letter state for the headline stats (default CA)")
    ap.add_argument("--fire", default=None, help="fire name for the time-lapse (substring, e.g. dixie)")
    ap.add_argument("--fps", type=int, default=3)
    ap.add_argument("--rebuild", action="store_true", help="rebuild the cache from the zip")
    a = ap.parse_args()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    gdf, work, n, how = load_all(a.rebuild)
    print(f"{len(work):,} perimeters, {n['inc'].nunique():,} fires. Timestamps from {how}.")
    scoped = n[n["state"] == a.state.upper()] if a.state else n
    h = headline(scoped, a.state.upper() if a.state else "all")
    chart_top10(h, OUT_DIR / "top10_one_day_jumps.png")
    hero_cards(h, OUT_DIR)
    pool = n[n["name"].str.contains(a.fire, case=False, na=False)] if a.fire else scoped
    inc = pool.groupby("inc")["acres"].max().idxmax()
    meta = n[n["inc"] == inc].iloc[0]
    sub = gdf.loc[work.index[work["inc"] == inc]].assign(night=work.loc[work["inc"] == inc, "night"])
    anim = chart_timelapse(frames_from_gdf(sub), pretty(meta["name"]), meta["state"],
                           n[n["inc"] == inc].set_index("night")["acres"],
                           OUT_DIR / f"timelapse_{slug(pretty(meta['name']))}.png",
                           OUT_DIR / f"timelapse_{slug(pretty(meta['name']))}.mp4", a.fps)
    (OUT_DIR / "summary.json").write_text(json.dumps({"dataset": CREDIT, "headline": h,
                                                      "timelapse": anim.name}, indent=2))
    print(json.dumps({k: v for k, v in h.items() if k != "top10"}, indent=2))
    print(f"Done. Files in {OUT_DIR}")


if __name__ == "__main__":
    main()
