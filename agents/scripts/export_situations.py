"""Export the head agent's situation log (SpacetimeDB `situation` table) as JSONL for the RL workstream.

    cd agents && ../venv/bin/python scripts/export_situations.py                 # exports/situations-<time>.jsonl
    ../venv/bin/python scripts/export_situations.py --out data.jsonl --features  # add the model-input vector
    ../venv/bin/python scripts/export_situations.py --keep-empty                 # keep fire-0-and-wind-0 rows

One JSON object per line, oldest first. Columns are exactly the table's; `stations` is parsed from stations_json.
With --features each row also gets `features` (Situation.feature_vector()) and `feature_version`/`feature_names`.
Rows recorded from an empty world (fire area 0 AND wind 0) are dropped unless --keep-empty."""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
from dataclasses import fields
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from rescue.config import AGENTS_ROOT, settings  # noqa: E402
from rescue.core.situation import FEATURE_NAMES, FEATURE_VERSION, Situation  # noqa: E402
from rescue.stdb import SpacetimeClient  # noqa: E402


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", help="output path (default exports/situations-<timestamp>.jsonl)")
    ap.add_argument("--features", action="store_true", help="include the feature vector")
    ap.add_argument("--keep-empty", action="store_true")
    a = ap.parse_args()

    db = SpacetimeClient("export")
    rows = sorted(await db.sql("SELECT * FROM situation"), key=lambda r: r["id"])
    kept = [r for r in rows if a.keep_empty or not (r["fire_area_sq_km"] == 0 and r["wind_speed_mps"] == 0)]
    out = Path(a.out) if a.out else AGENTS_ROOT / "exports" / f"situations-{time.strftime('%Y%m%d-%H%M%S')}.jsonl"
    out.parent.mkdir(parents=True, exist_ok=True)
    names = [f.name for f in fields(Situation)]
    with out.open("w") as f:
        for r in kept:
            row = {**r, "stations": json.loads(r["stations_json"])}
            if a.features:
                row["features"] = [round(x, 6) for x in Situation(**{k: r[k] for k in names}).feature_vector()]
                row["feature_version"] = FEATURE_VERSION
                row["feature_names"] = FEATURE_NAMES
            f.write(json.dumps(row) + "\n")
    print(f"{settings.stdb_db}: {len(rows)} rows in the table, wrote {len(kept)} to {out}"
          + (f" ({len(rows) - len(kept)} empty-world row(s) dropped)" if len(kept) != len(rows) else ""))
    await db.close()


if __name__ == "__main__":
    asyncio.run(main())
