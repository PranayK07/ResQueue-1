"""News agent: wildfire coverage scraped by Bright Data, stored in SpacetimeDB.

  NEWS_SOURCE=brightdata  run the Scraper Studio collector (one input per
                          keyword, at NEWS_LOCATION) every NEWS_POLL_S
  NEWS_SOURCE=file        replay NEWS_FIXTURE (a saved collector export)
  NEWS_SOURCE=off         do nothing

With an incident selected (incident table, see incidents.json) the agent
queries that incident's keywords/location, keeps only articles published in
its news window, tags them with the incident, and scrapes ONLY on an explicit
"refresh news": a historical window never changes, so polling would just
burn page loads. Every raw scrape is also saved to news_archive/<incident>.jsonl
so a demo can be replayed without paying to scrape again.

Each article is scored for relevance to this incident and mined for
evacuation orders, road closures, containment and acreage, then upserted
into `news_article` via publish_news. These are hints for the commander:
nothing here changes roads or queues on its own.
"""
from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

from uagents import Context

from ..config import AGENTS_ROOT, STATE_DIR, settings
from ..data import brightdata
from ..messages import NewsItem, NewsRefreshRequest, NewsRefreshResult, NewsReport, NewsReportRequest
from ..news.signals import extract
from .base import MeshAgent

CHUNK = 20


def _fmt_micros(m: int | None) -> str:
    return datetime.fromtimestamp(m / 1e6, timezone.utc).strftime("%Y-%m-%d %H:%M UTC") if m else "unknown date"


class NewsAgent(MeshAgent):
    queries = ["SELECT * FROM station", "SELECT * FROM news_article", "SELECT * FROM incident"]

    def __init__(self) -> None:
        super().__init__("news")
        self._lock = asyncio.Lock()
        self.last_fetch = ""
        self._last_run = -1e9  # loop time of the last scheduled run
        self._tasks: set[asyncio.Task] = set()  # strong refs so background scrapes aren't garbage-collected

        @self.agent.on_message(NewsReportRequest, replies=NewsReport)
        async def _report(ctx: Context, sender: str, msg: NewsReportRequest):
            if await self.when_ready(ctx):
                await ctx.send(sender, self.report(msg.limit))

        @self.agent.on_message(NewsRefreshRequest, replies=NewsRefreshResult)
        async def _refresh(ctx: Context, sender: str, _msg: NewsRefreshRequest):
            if not await self.when_ready(ctx):
                return
            if self._lock.locked():
                await ctx.send(sender, NewsRefreshResult(ok=False, message="a scrape is already running"))
                return
            allowed, why = self.scrape_allowance()
            if not allowed:
                await ctx.send(sender, NewsRefreshResult(ok=False, message=why))
                return
            # Reply right away; Bright Data runs take 30-90 s. The commander sees
            # results via the news report / event feed when the run lands.
            self._spawn(self.fetch(ctx))
            await ctx.send(sender, NewsRefreshResult(ok=True, message=f"news refresh started ({settings.news_source})"))

        @self.agent.on_interval(period=settings.news_poll_s)
        async def _poll(ctx: Context):
            # uAgents fires intervals once at startup too; on_ready already
            # fetched, and every Bright Data run costs page loads.
            if self._historical():
                return
            if self.db.identity and asyncio.get_running_loop().time() - self._last_run >= settings.news_poll_s * 0.9:
                await self.fetch(ctx)

    def _spawn(self, coro) -> None:
        task = asyncio.create_task(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def on_ready(self, ctx: Context) -> None:
        ctx.logger.info(f"news source={settings.news_source}, poll every {settings.news_poll_s:.0f}s")
        # Never await a scrape here: uAgents doesn't run heartbeats or answer messages until
        # startup handlers return, and a Bright Data run takes minutes.
        self._spawn(self._startup_fetch(ctx))

    async def _startup_fetch(self, ctx: Context) -> None:
        """Scrape on startup only if SpacetimeDB has no recent articles. Results persist in the
        database, so restarting the agent doesn't re-run (and re-bill) a scrape."""
        loop = asyncio.get_running_loop()
        inc = self.incident_row()
        if self._historical():
            n = len(self._rows_for(inc))
            label = inc["name"] if inc else "live news"
            self.set_status("online", f"{label}: {n} articles on file; scraping is manual" + ("" if n else " (say 'refresh news': costs Bright Data credits)"))
            ctx.logger.info(f"news: {n} articles on file; scraping only on 'refresh news' (NEWS_AUTO_SCRAPE off or incident selected)")
            return
        newest = max((r["fetched_at"] for r in self._rows_for(inc)), default=0)  # micros
        age_s = datetime.now(timezone.utc).timestamp() - newest / 1e6 if newest else float("inf")
        if settings.news_source == "brightdata" and age_s < settings.news_poll_s:
            self._last_run = loop.time() - age_s  # the next scheduled run is due poll_s after the last real one
            self.set_status("online", f"{len(self._rows_for(inc))} articles on file (last scrape {age_s / 60:.0f} min ago)")
            ctx.logger.info(f"news: recent articles on file ({age_s / 60:.0f} min old); skipping startup scrape")
            return
        await self.fetch(ctx)

    def incident_row(self) -> dict | None:
        return self.db.table("incident").one()

    def scrape_allowance(self) -> tuple[bool, str]:
        """Hard daily cap on Bright Data runs, counted per UTC day in a file so restarting the agent can't reset it."""
        if settings.news_source != "brightdata":
            return True, ""
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        used = self._scrape_count(today)
        if used >= settings.news_max_scrapes_per_day:
            return False, (f"daily Bright Data cap reached ({used}/{settings.news_max_scrapes_per_day} runs today, UTC). "
                           "Raise NEWS_MAX_SCRAPES_PER_DAY in .env if you really want more.")
        return True, ""

    @staticmethod
    def _counter_path() -> Path:
        return STATE_DIR / "news-scrapes.json"

    def _scrape_count(self, today: str) -> int:
        try:
            st = json.loads(self._counter_path().read_text())
        except (OSError, json.JSONDecodeError):
            return 0
        return int(st.get("count", 0)) if st.get("date") == today else 0

    def _count_scrape(self) -> None:
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        self._counter_path().write_text(json.dumps({"date": today, "count": self._scrape_count(today) + 1}))

    def _historical(self) -> bool:
        """True when scraping costs money and nobody asked for it: an incident is selected (a historical window
        never changes), or NEWS_AUTO_SCRAPE is off (the default). Then only 'refresh news' scrapes."""
        return settings.news_source == "brightdata" and (self.incident_row() is not None or not settings.news_auto_scrape)

    def _rows_for(self, inc: dict | None) -> list[dict]:
        """Stored articles belonging to the current incident (or live mode)."""
        key = inc["key"] if inc else ""
        return [r for r in self.db.table("news_article") if r["incident"] == key]

    def places(self) -> list[str]:
        inc = self.incident_row()
        source = inc["places"] if inc else settings.news_places
        names = [p.strip() for p in source.split(",") if p.strip()]
        for s in self.db.table("station"):  # "Station 81 (Paradise)" -> "Paradise"
            inner = s["name"].split("(")[-1].rstrip(")").strip()
            if inner and inner not in names:
                names.append(inner)
        return names

    async def _rows(self) -> tuple[list[dict], str]:
        if settings.news_source == "file":
            path = AGENTS_ROOT / settings.news_fixture
            return brightdata.load_fixture(path), f"fixture {path.name}"
        inc = self.incident_row()
        if inc:
            keywords, location = [q.strip() for q in inc["queries"].split("|") if q.strip()], inc["location"]
        else:
            keywords, location = [k.strip() for k in settings.news_keywords.split(",") if k.strip()], settings.news_location
        # The collector ignores keyword/location when `url` is set, so leave it empty.
        inputs = [{"url": "", "location": location, "search_keyword": k} for k in keywords]
        if inc and settings.news_send_dates:  # only if the collector declares these inputs (else HTTP 422)
            iso = lambda m: datetime.fromtimestamp(m / 1e6, timezone.utc).strftime("%Y-%m-%d")  # noqa: E731
            inputs = [{**i, "date_from": iso(inc["news_from"]), "date_to": iso(inc["news_to"])} for i in inputs]
        rows = await brightdata.trigger_and_collect(settings.brightdata_api_key, settings.brightdata_collector_id, inputs)
        return rows, f"Bright Data ({len(inputs)} queries)"

    async def fetch(self, ctx: Context) -> None:
        if settings.news_source not in ("file", "brightdata") or self._lock.locked():
            return
        async with self._lock:
            allowed, why = self.scrape_allowance()
            if not allowed:
                ctx.logger.warning(f"news: {why}")
                self.set_status("online", why[:200])
                return
            if settings.news_source == "brightdata":
                self._count_scrape()  # before the call: a failed run is still billed
            self._last_run = asyncio.get_running_loop().time()
            self.set_status("fetching", f"scraping via {settings.news_source}")
            try:
                rows, origin = await self._rows()
            except Exception as e:  # noqa: BLE001 - a dead feed must not kill the agent
                ctx.logger.error(f"news fetch failed: {e}")
                self.set_status("degraded", f"news fetch failed: {e}"[:200])
                return
            inc = self.incident_row()
            archived = self.archive(inc, rows)
            places = self.places()
            query = (" | ".join(inc["queries"].split("|")) + f" @ {inc['location']}") if inc else f"{settings.news_keywords} @ {settings.news_location}"
            articles = []
            outside = undated = 0
            for row in rows:
                a = brightdata.normalize(row)
                if a is None:
                    continue
                if inc:  # keep only coverage published inside the incident's news window
                    if a.published_micros <= 0:
                        undated += 1
                        continue
                    if not inc["news_from"] <= a.published_micros <= inc["news_to"]:
                        outside += 1
                        continue
                sig = extract(a.title, a.content, a.published_micros, places, fixed_recency=1.0 if inc else None)
                articles.append({
                    "url": a.url, "source": urlparse(a.url).netloc.removeprefix("www.") or "web",
                    "incident": inc["key"] if inc else "", "title": a.title,
                    "author": a.author, "published_raw": a.published_raw, "published_micros": a.published_micros,
                    "category": a.category, "tags": a.tags, "summary": sig.summary, "content": a.content,
                    "query": query, "relevance": sig.relevance, "location_match": sig.location_match,
                    "evacuation": sig.evacuation, "closures": sig.closures,
                    "containment_pct": sig.containment_pct, "acres": sig.acres,
                })
            for i in range(0, len(articles), CHUNK):
                if not await self.db.try_call("publish_news", articles[i:i + CHUNK]):
                    self.set_status("degraded", "SpacetimeDB rejected publish_news")
                    return
            self.last_fetch = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            relevant = sum(a["relevance"] >= 0.5 for a in articles)
            window = f" in window ({outside} outside, {undated} undated, {archived} new in archive)" if inc else ""
            self.set_status("online", f"{len(articles)} articles{window} from {origin}, {relevant} relevant (last {self.last_fetch[11:16]} UTC)")
            ctx.logger.info(f"news: {len(articles)} articles{window} from {origin}, {relevant} relevant")

    def archive(self, inc: dict | None, rows: list[dict]) -> int:
        """Append raw scraped rows (deduped by url) to news_archive/<incident>.jsonl, so a demo can
        be replayed from disk instead of paying for another scrape. Returns how many were new."""
        path = Path(AGENTS_ROOT / settings.news_archive_dir / f"{inc['key'] if inc else 'live'}.jsonl")
        path.parent.mkdir(parents=True, exist_ok=True)
        seen = set()
        if path.exists():
            for line in path.read_text().splitlines():
                try:
                    seen.add(json.loads(line).get("url"))
                except json.JSONDecodeError:
                    pass
        fresh = [r for r in rows if r.get("url") and r["url"] not in seen]
        if fresh:
            with path.open("a") as f:
                f.writelines(json.dumps(r, ensure_ascii=False) + "\n" for r in fresh)
        return len(fresh)

    def report(self, limit: int = 5) -> NewsReport:
        inc = self.incident_row()
        rows = sorted(self._rows_for(inc),
                      key=lambda r: (r["relevance"], r["published_at"] or 0), reverse=True)[:max(1, min(limit, 20))]
        items = [NewsItem(
            title=r["title"], url=r["url"], published=r["published_raw"] or _fmt_micros(r["published_at"]),
            relevance=round(r["relevance"], 2), evacuation=r["evacuation"], closures=r["closures"],
            containment_pct=r["containment_pct"] if r["containment_pct"] is not None else -1.0,
            acres=r["acres"] if r["acres"] is not None else -1.0,
        ) for r in rows]
        relevant = [i for i in items if i.relevance >= 0.5]
        if not items:
            summary = ("A scrape is running (takes a few minutes); nothing ingested yet." if self._lock.locked()
                       else f"No stored news for {inc['name']}; 'refresh news' scrapes it (costs page loads)." if inc
                       else "No news ingested yet.")
        elif not relevant:
            summary = f"{len(self._rows_for(inc))} articles stored, none about this incident area."
        else:
            top = relevant[0]
            bits = [b for b in (
                "evacuation orders" if any(i.evacuation for i in relevant) else "",
                "road closures" if any(i.closures for i in relevant) else "",
                f"{max(i.containment_pct for i in relevant):.0f}% containment" if any(i.containment_pct >= 0 for i in relevant) else "",
            ) if b]
            summary = f'{len(relevant)} relevant: "{top.title[:90]}"' + (f" — reports of {', '.join(bits)}" if bits else "")
        if items and self._lock.locked():
            summary += " (a new scrape is running)"
        # ISO-8601 UTC. After a restart the in-memory value is empty, so fall back to the newest stored scrape.
        newest = max((r["fetched_at"] for r in self._rows_for(inc)), default=0)
        last = self.last_fetch or (datetime.fromtimestamp(newest / 1e6, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ") if newest else "")
        return NewsReport(items=items, summary=summary, last_fetch=last, source=settings.news_source)


if __name__ == "__main__":
    NewsAgent().run()
