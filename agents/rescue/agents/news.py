"""News agent: wildfire status from trusted X accounts, collected by Bright Data, stored in SpacetimeDB.

WHERE and WHEN come from the shared tables (news/focus.py), so any component can steer it:

  ping_news(lat, lon, label)   WHERE: a location ping (web app, commander "ping", scripts/ping_news.py, any agent)
  set_incident / clear_incident  WHEN: a replay window (a catalog fire, or any range, e.g. 2020-09-27 -> 2020-10-20),
                               or live (the last NEWS_LIVE_LOOKBACK_H hours)

On every change of either it re-scores the posts already stored for the new place (free), then pulls the trusted
accounts near it (news_sources.json, news/sources.py) that aren't on file yet for that time window
(NEWS_FETCH_ON_PING). Bright Data's pre-built X Posts scraper (data/brightdata.py) does the collecting:

  NEWS_SOURCE=brightdata  "Discover by profile url" for those accounts (NEWS_POSTS_PER_ACCOUNT newest posts each,
                          or the window itself with NEWS_SEND_DATES), plus "Collect by URL" for status posts
                          listed in the incident catalog
  NEWS_SOURCE=file        replay NEWS_FIXTURE (X Posts records: a JSON array, or a news_archive/*.jsonl)
  NEWS_SOURCE=off         do nothing

"refresh news" re-pulls every account; "track https://x.com/<account>/status/<id>" collects one post (Collect by
URL; doesn't count against the daily cap). Posts outside the time window are dropped, posts inside are tagged
with the incident ('' = live). Profile discovery returns an account's newest posts, so for a past window most
fall outside unless NEWS_SEND_DATES asks Bright Data for the window; catalog `posts` and tracked posts work for
any date. Every raw scrape is saved to news_archive/<incident>.jsonl so a demo can replay it for free.

Each post is scored for relevance to the focus (topic, incident name / place names, recency, and how trusted and
how local the account is) and mined for evacuation orders, road closures, shelters and relief, containment and
acreage, then upserted into `news_article` via publish_news. These are hints for the commander: nothing here
changes roads or queues on its own.
"""
from __future__ import annotations

import asyncio
import json
import time
from datetime import datetime, timezone
from pathlib import Path

from uagents import Context

from .. import incidents
from ..config import AGENTS_ROOT, STATE_DIR, settings
from ..data import brightdata
from ..messages import (NewsItem, NewsRefreshRequest, NewsRefreshResult, NewsReport, NewsReportRequest,
                        NewsTrackRequest)
from ..news import sources
from ..news.focus import Focus, resolve
from ..news.signals import Signals, extract
from ..stdb import Debouncer
from .base import MeshAgent

CHUNK = 20


def _fmt_micros(m: int | None) -> str:
    return datetime.fromtimestamp(m / 1e6, timezone.utc).strftime("%Y-%m-%d %H:%M UTC") if m else "unknown date"


def _headline(text: str) -> str:
    line = " ".join(text.strip().splitlines()[0].split()) if text.strip() else ""
    return line if len(line) <= 140 else line[:139].rsplit(" ", 1)[0] + "…"


class NewsAgent(MeshAgent):
    queries = ["SELECT * FROM station", "SELECT * FROM news_article", "SELECT * FROM incident", "SELECT * FROM news_focus"]

    def __init__(self) -> None:
        super().__init__("news")
        self.registry = sources.load_registry(AGENTS_ROOT / settings.news_sources_file)
        self._lock = asyncio.Lock()
        self.last_fetch = ""
        self._last_run = -1e9  # loop time of the last scheduled run
        self._focus_sig: tuple | None = None  # the focus last acted on (None until the first sync)
        self._focus_debounce: Debouncer | None = None
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
            # Reply right away; a discovery job takes minutes. The commander sees results via the
            # news report / event feed when the run lands.
            f = self.focus()
            self._spawn(self.fetch())
            who = ", ".join(f"@{a.handle}" for a in self.accounts(f))
            await ctx.send(sender, NewsRefreshResult(ok=True, message=f"news refresh started ({settings.news_source}) for {f.describe()}: {who}"))

        @self.agent.on_message(NewsTrackRequest, replies=NewsRefreshResult)
        async def _track(ctx: Context, sender: str, msg: NewsTrackRequest):
            if not await self.when_ready(ctx):
                return
            url = brightdata.x_post_url(msg.url)
            if not url:
                why = f"not an X post link: {msg.url[:100]} (expected https://x.com/<account>/status/<id>)"
            elif settings.news_source != "brightdata":
                why = f"tracking a post needs NEWS_SOURCE=brightdata (now {settings.news_source})"
            elif self._lock.locked():
                why = "a scrape is already running; try again when it lands"
            else:
                self._spawn(self.fetch(track=url))
                await ctx.send(sender, NewsRefreshResult(ok=True, message=f"collecting {url} (usually under a minute)"))
                return
            await ctx.send(sender, NewsRefreshResult(ok=False, message=why))

        @self.agent.on_interval(period=settings.news_poll_s)
        async def _poll(_ctx: Context):
            # Live mode only (a past window doesn't change), and only with NEWS_AUTO_SCRAPE: every run is billed.
            # uAgents fires intervals once at startup too, hence the time check.
            if settings.news_source != "brightdata" or not settings.news_auto_scrape or not self.ready.is_set():
                return
            if self.focus().live and asyncio.get_running_loop().time() - self._last_run >= settings.news_poll_s * 0.9:
                await self.fetch(only_new=True)

    def _spawn(self, coro) -> None:
        task = asyncio.create_task(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def on_ready(self, ctx: Context) -> None:
        ctx.logger.info(f"news source={settings.news_source}, fetch on ping={settings.news_fetch_on_ping}, "
                        f"auto={settings.news_auto_scrape}; focus {self.focus().describe()}")
        # Fires on the first sync too (handled as startup: no billed scrape unless NEWS_AUTO_SCRAPE). Never await a
        # scrape in on_ready: uAgents doesn't run heartbeats or answer messages until startup handlers return.
        self._focus_debounce = Debouncer(self._on_focus, delay=1.0, min_interval=2.0)  # coalesces set_incident + ping_news
        self.db.on_update(["news_focus", "incident", "station"], lambda _u: self._focus_debounce.trigger())
        self._focus_debounce.trigger()

    # ── where and when ──────────────────────────────────────────────────────

    def incident_row(self) -> dict | None:
        return self.db.table("incident").one()

    def catalog_entry(self) -> incidents.Incident | None:
        """The selected incident's catalog entry (center, pinned accounts, posts), if it is in incidents.json."""
        inc = self.incident_row()
        if not inc:
            return None
        try:
            return incidents.load_catalog().get(inc["key"])
        except (OSError, ValueError, KeyError) as e:
            self.log.warning("incidents.json unreadable: %s", e)
            return None

    def focus(self) -> Focus:
        entry = self.catalog_entry()
        return resolve(self.db.table("news_focus").one(), self.incident_row(), entry.center if entry else None,
                       list(self.db.table("station")), now_micros=int(time.time() * 1e6),
                       live_lookback_h=settings.news_live_lookback_h)

    def accounts(self, f: Focus) -> list[sources.Account]:
        entry = self.catalog_entry()
        pinned = (entry.accounts if entry else []) + settings.news_accounts.split(",")
        return sources.select(self.registry, f.center, pinned=pinned, limit=settings.news_max_accounts)

    def places(self, f: Focus) -> list[str]:
        inc = self.incident_row()
        source = inc["places"] if inc else settings.news_places
        names = [p.strip() for p in source.split(",") if p.strip()]
        ping = f.label.split(",")[0].strip()  # "Calistoga, CA" -> "Calistoga"
        if len(ping) >= 3 and ping not in names:
            names.append(ping)
        for s in self.db.table("station"):  # "Station 81 (Paradise)" -> "Paradise"
            inner = s["name"].split("(")[-1].rstrip(")").strip()
            if inner and inner not in names:
                names.append(inner)
        return names

    def _scorer(self, f: Focus):
        places, center = self.places(f), f.center
        inc = self.incident_row()
        terms = [q.strip() for q in inc["queries"].split("|") if q.strip()] if inc else []

        def score(text: str, published_micros: int, acct: sources.Account) -> Signals:
            return extract(text, published_micros, places, terms=terms, trust=acct.trust,
                           local_source=bool(center) and acct.is_local(*center), fixed_recency=None if f.live else 1.0)
        return score

    async def _on_focus(self) -> None:
        """WHERE or WHEN changed (or the first sync): re-score what's stored, then pull what's missing."""
        if not self.ready.is_set():
            await self.ready.wait()
        f = self.focus()
        if f.signature() == self._focus_sig:
            return
        first, self._focus_sig = self._focus_sig is None, f.signature()
        self.log.info("news focus (%s): %s", f.where, f.describe())
        await self.rescore(f)
        if settings.news_source == "file":
            await self.fetch()
        elif settings.news_source == "brightdata":
            if settings.news_auto_scrape if first else settings.news_fetch_on_ping:
                await self.fetch(only_new=True)
            else:
                n = len(self._rows_in(f))
                self.set_status("online", f"{n} posts on file for {f.describe()}; 'refresh news' pulls more (costs Bright Data credits)"[:200])

    async def rescore(self, f: Focus) -> int:
        """Relevance depends on where we look: update stored posts of this scope for the current focus."""
        score, updates = self._scorer(f), []
        for r in self._rows_for(f.scope):
            sig = score(r["content"] or r["summary"], r["published_at"] or 0, sources.lookup(self.registry, r["source"]))
            if abs(sig.relevance - r["relevance"]) > 0.005 or sig.location_match != r["location_match"]:
                updates.append({"url": r["url"], "relevance": sig.relevance, "location_match": sig.location_match})
        for i in range(0, len(updates), 100):
            if not await self.db.try_call("rescore_news", updates[i:i + 100]):
                self.log.warning("SpacetimeDB rejected rescore_news")
                return 0
        if updates:
            self.log.info("re-scored %d stored posts for %s", len(updates), f.describe())
        return len(updates)

    # ── cost control ────────────────────────────────────────────────────────

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

    @staticmethod
    def _fetched_path() -> Path:
        return STATE_DIR / "news-fetched.json"

    def _fetched(self) -> dict:
        """{scope ('live' or incident key): {account handle or post url (lowercase): unix time pulled}}."""
        try:
            return json.loads(self._fetched_path().read_text())
        except (OSError, json.JSONDecodeError):
            return {}

    def _stale(self, f: Focus, keys: list[str]) -> list[str]:
        """Which accounts / posts aren't on file for this window: a past window is pulled once, live ones
        again after NEWS_POLL_S."""
        done = self._fetched().get(f.scope or "live", {})
        now = time.time()
        return [k for k in keys if k.lower() not in done or (f.live and now - done[k.lower()] >= settings.news_poll_s * 0.9)]

    def _mark_fetched(self, f: Focus, keys: list[str]) -> None:
        st = self._fetched()
        st.setdefault(f.scope or "live", {}).update({k.lower(): time.time() for k in keys})
        self._fetched_path().write_text(json.dumps(st))

    # ── collecting ──────────────────────────────────────────────────────────

    def _rows_for(self, scope: str) -> list[dict]:
        """Stored posts tagged with this incident ('' = live)."""
        return [r for r in self.db.table("news_article") if r["incident"] == scope]

    def _rows_in(self, f: Focus) -> list[dict]:
        """Stored posts for the focus: its scope, published inside its time window."""
        return [r for r in self._rows_for(f.scope) if f.contains(r["published_at"] or 0)]

    def _date_inputs(self, f: Focus) -> dict:
        if not settings.news_send_dates:
            return {}
        day = lambda m: datetime.fromtimestamp(m / 1e6, timezone.utc).strftime(settings.news_date_format)  # noqa: E731
        return {"start_date": day(f.window_from), "end_date": day(f.window_to)}

    async def _collect(self, f: Focus, accounts: list[sources.Account], posts: list[str], track: str) -> tuple[list[dict], str]:
        """Raw X Posts records, and where they came from."""
        if settings.news_source == "file":
            path = AGENTS_ROOT / settings.news_fixture
            return brightdata.load_fixture(path), f"fixture {path.name}"
        key, ds = settings.brightdata_api_key, settings.brightdata_x_dataset_id
        if track:
            return await brightdata.collect_posts(key, [track], dataset_id=ds), "X post (collect by URL)"
        self._count_scrape()  # before the call: a failed run is still billed
        jobs = []
        if accounts:
            jobs.append(brightdata.discover_posts(key, [{"url": a.url, **self._date_inputs(f)} for a in accounts],
                                                  dataset_id=ds, limit_per_input=settings.news_posts_per_account))
        if posts:
            jobs.append(brightdata.collect_posts(key, posts, dataset_id=ds))
        batches = await asyncio.gather(*jobs)
        origin = f"X via Bright Data ({len(accounts)} accounts" + (f", {len(posts)} posts" if posts else "") + ")"
        return [r for b in batches for r in b], origin

    async def fetch(self, *, track: str = "", only_new: bool = False) -> None:
        """One scrape for the current focus: its accounts (+ catalog posts), only those not on file yet with
        `only_new`, or with `track` just that one post."""
        if settings.news_source not in ("file", "brightdata") or self._lock.locked():
            return
        async with self._lock:
            f = self.focus()
            accounts, posts = [], []
            if not track and settings.news_source == "brightdata":
                entry = self.catalog_entry()
                accounts = self.accounts(f)
                posts = [u for u in (brightdata.x_post_url(p) for p in (entry.posts if entry else [])) if u]
                if only_new:
                    stale = set(self._stale(f, [a.handle for a in accounts] + posts))
                    accounts, posts = [a for a in accounts if a.handle in stale], [u for u in posts if u in stale]
                if not accounts and not posts:
                    n = len(self._rows_in(f))
                    why = "every account near it is already on file" if only_new else "no X accounts cover it (add some to news_sources.json or NEWS_ACCOUNTS)"
                    self.set_status("online", f"{n} posts for {f.describe()}; {why}"[:200])
                    self.log.info("news: nothing to pull for %s (%s)", f.describe(), why)
                    return
                allowed, why = self.scrape_allowance()
                if not allowed:
                    self.log.warning("news: %s", why)
                    self.set_status("online", why[:200])
                    return
                self._last_run = asyncio.get_running_loop().time()
            self.set_status("fetching", f"collecting {track}" if track else f"pulling {len(accounts) or 'fixture'} accounts for {f.describe()}"[:200])
            try:
                rows, origin = await self._collect(f, accounts, posts, track)
            except Exception as e:  # noqa: BLE001 - a dead feed must not kill the agent
                self.log.error("news fetch failed: %s", e)
                self.set_status("degraded", f"news fetch failed: {e}"[:200])
                return
            if settings.news_source == "brightdata" and not track:
                self._mark_fetched(f, [a.handle for a in accounts] + posts)
            inc = self.incident_row()
            archived = self.archive(inc, rows)
            errors = brightdata.input_errors(rows)
            for err in errors:  # usually a handle that doesn't exist (fix it in news_sources.json) or a deleted post
                self.log.warning("news: Bright Data input error: %s", err)
            score, direct = self._scorer(f), set(posts) | ({track} if track else set())
            articles, seen = [], set()
            outside = undated = 0
            for row in rows:
                p = brightdata.normalize(row)
                if p is None or p.url in seen:
                    continue
                seen.add(p.url)
                if not f.contains(p.published_micros):  # keep only posts published inside the time window
                    undated += p.published_micros <= 0
                    outside += p.published_micros > 0
                    continue
                acct = sources.lookup(self.registry, p.handle)
                sig = score(p.text, p.published_micros, acct)
                articles.append({
                    "url": p.url, "source": f"@{acct.handle}", "incident": f.scope,
                    "title": _headline(p.text), "author": p.name or acct.name,
                    "published_raw": p.published_raw, "published_micros": p.published_micros,
                    "category": acct.kind, "tags": ",".join(p.hashtags), "summary": sig.summary, "content": p.text,
                    "query": "post url" if p.url in direct else f"profile @{acct.handle}",
                    "relevance": sig.relevance, "location_match": sig.location_match,
                    "evacuation": sig.evacuation, "closures": sig.closures, "relief": sig.relief,
                    "containment_pct": sig.containment_pct, "acres": sig.acres, "official": acct.official,
                })
            for i in range(0, len(articles), CHUNK):
                if not await self.db.try_call("publish_news", articles[i:i + CHUNK]):
                    self.set_status("degraded", "SpacetimeDB rejected publish_news")
                    return
            self.last_fetch = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            relevant = sum(a["relevance"] >= 0.5 for a in articles)
            window = f" in window ({outside} outside, {undated} undated, {archived} new in archive)"
            errs = f"; {len(errors)} input error(s), first: {errors[0]}" if errors else ""
            self.set_status("degraded" if errors and not articles else "online",
                            f"{len(articles)} posts{window} from {origin}, {relevant} relevant (last {self.last_fetch[11:16]} UTC){errs}"[:200])
            self.log.info("news: %d posts%s from %s for %s, %d relevant%s", len(articles), window, origin, f.describe(), relevant, errs)

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
        fresh = [r for r in rows if r.get("url") and r.get("description") and r["url"] not in seen]
        if fresh:
            with path.open("a") as f:
                f.writelines(json.dumps(r, ensure_ascii=False) + "\n" for r in fresh)
        return len(fresh)

    def report(self, limit: int = 5) -> NewsReport:
        f = self.focus()
        stored = self._rows_in(f)
        rows = sorted(stored, key=lambda r: (r["relevance"], r["published_at"] or 0), reverse=True)[:max(1, min(limit, 20))]
        items = [NewsItem(
            title=r["title"], url=r["url"], source=r["source"], official=r["official"],
            published=_fmt_micros(r["published_at"]) if r["published_at"] else r["published_raw"] or "unknown date",
            relevance=round(r["relevance"], 2), evacuation=r["evacuation"], closures=r["closures"], relief=r["relief"],
            containment_pct=r["containment_pct"] if r["containment_pct"] is not None else -1.0,
            acres=r["acres"] if r["acres"] is not None else -1.0,
        ) for r in rows]
        relevant = [i for i in items if i.relevance >= 0.5]
        if not items:
            summary = ("A scrape is running (takes a few minutes); nothing ingested yet." if self._lock.locked()
                       else "No posts stored for this place and time; 'refresh news' pulls them from X (costs Bright Data credits).")
        elif not relevant:
            summary = f"{len(stored)} posts stored, none about this area."
        else:
            top = relevant[0]
            bits = [b for b in (
                "evacuation orders" if any(i.evacuation for i in relevant) else "",
                "road closures" if any(i.closures for i in relevant) else "",
                "shelters / relief" if any(i.relief for i in relevant) else "",
                f"{max(i.containment_pct for i in relevant):.0f}% containment" if any(i.containment_pct >= 0 for i in relevant) else "",
            ) if b]
            summary = f'{len(relevant)} relevant: {top.source} "{top.title[:90]}"' + (f" — reports of {', '.join(bits)}" if bits else "")
        if items and self._lock.locked():
            summary += " (a new scrape is running)"
        # ISO-8601 UTC. After a restart the in-memory value is empty, so fall back to the newest stored scrape.
        newest = max((r["fetched_at"] for r in self._rows_for(f.scope)), default=0)
        last = self.last_fetch or (datetime.fromtimestamp(newest / 1e6, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ") if newest else "")
        return NewsReport(items=items, summary=summary, last_fetch=last, source=settings.news_source,
                          accounts=[f"@{a.handle}" for a in self.accounts(f)], focus=f.describe())


if __name__ == "__main__":
    NewsAgent().run()
