"""Call Bright Data's X Posts scraper directly (no SpacetimeDB, no agents) to check the API key, the account handles
and the date inputs before running the whole mesh. Billed per post returned; the news agent's daily cap does NOT
apply here, so keep --limit small.

    python scripts/try_brightdata.py --near 38.578 -122.579                    # accounts the agent would follow there (free)
    python scripts/try_brightdata.py --post https://x.com/CAL_FIRE/status/<id>  # Collect by URL: one record
    python scripts/try_brightdata.py --accounts CAL_FIRE,NWSSacramento --limit 3   # Discover by profile url
    python scripts/try_brightdata.py --accounts CALFIRELNU --limit 5 --from 2020-09-27 --to 2020-10-20
                                     # are start_date/end_date honored? (compare "in window" with and without)
    add --dry-run to print the request without sending it

Raw rows are saved to news_archive/try-<time>.jsonl (replayable with NEWS_SOURCE=file)."""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from rescue import incidents  # noqa: E402
from rescue.config import AGENTS_ROOT, settings  # noqa: E402
from rescue.data import brightdata  # noqa: E402
from rescue.news import sources  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    what = ap.add_mutually_exclusive_group(required=True)
    what.add_argument("--near", nargs=2, type=float, metavar=("LAT", "LON"), help="show the accounts selected near a point")
    what.add_argument("--post", action="append", help="X post URL (repeatable): Collect by URL")
    what.add_argument("--accounts", help="comma list of handles: Discover by profile url")
    ap.add_argument("--limit", type=int, default=3, help="posts per account (limit_per_input)")
    ap.add_argument("--from", dest="start", help="YYYY-MM-DD: send start_date/end_date inputs (with --to)")
    ap.add_argument("--to", dest="end")
    ap.add_argument("--date-format", default=settings.news_date_format)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    registry = sources.load_registry(AGENTS_ROOT / settings.news_sources_file)

    if a.near:
        for acct in sources.select(registry, tuple(a.near), pinned=settings.news_accounts.split(","), limit=settings.news_max_accounts):
            print(f"@{acct.handle:18s} {acct.kind:10s} {'official' if acct.official else 'non-gov':9s} "
                  f"covers {acct.radius_km:.0f} km, {acct.distance_km(*a.near):.0f} km away  {acct.name}")
        return

    window = incidents.adhoc(a.start, a.end) if a.start and a.end else None
    dates = {"start_date": window.news_from.strftime(a.date_format), "end_date": window.news_to.strftime(a.date_format)} if window else {}
    key, ds = settings.brightdata_api_key, settings.brightdata_x_dataset_id
    if a.post:
        urls = [brightdata.x_post_url(u) or u for u in a.post]
        print(f"Collect by URL ({ds}): {urls}")
        call = None if a.dry_run else brightdata.collect_posts(key, urls, dataset_id=ds)
    else:
        inputs = [{"url": sources.lookup(registry, h).url, **dates} for h in a.accounts.split(",") if h.strip()]
        print(f"Discover by profile url ({ds}), limit_per_input={a.limit}:\n  " + json.dumps(inputs))
        call = None if a.dry_run else brightdata.discover_posts(key, inputs, dataset_id=ds, limit_per_input=a.limit)
    if call is None:
        print("(dry run: nothing sent)")
        return
    rows = asyncio.run(call)

    out = AGENTS_ROOT / settings.news_archive_dir / f"try-{datetime.now(timezone.utc):%Y%m%dT%H%M%SZ}.jsonl"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows))
    posts = [p for p in map(brightdata.normalize, rows) if p]
    print(f"\n{len(rows)} rows: {len(posts)} posts, {len(brightdata.input_errors(rows))} input errors (raw: {out})")
    for err in brightdata.input_errors(rows):
        print(f"  ERROR {err}")
    for p in sorted(posts, key=lambda p: p.published_micros, reverse=True):
        inside = "" if not window else ("  in window" if window.news_from.timestamp() * 1e6 <= p.published_micros <= window.news_to.timestamp() * 1e6 else "  OUTSIDE window")
        print(f"  {p.published_raw[:16]} @{p.handle}: {p.text.splitlines()[0][:100]}{inside}")
    if rows and not posts:
        print("Rows came back but none parsed as posts: check the field names in the raw file against brightdata.normalize().")


if __name__ == "__main__":
    main()
