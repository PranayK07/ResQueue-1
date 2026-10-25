"""Environment-driven settings shared by every agent process."""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

REPO_ROOT = Path(__file__).resolve().parents[2]
AGENTS_ROOT = REPO_ROOT / "agents"
STATE_DIR = REPO_ROOT / ".agent-state"  # SpacetimeDB tokens, caches (gitignored)

load_dotenv(REPO_ROOT / ".env")


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default)


_SERVERS = {"local": "http://127.0.0.1:3000", "maincloud": "https://maincloud.spacetimedb.com"}


@dataclass(frozen=True)
class Settings:
    # STDB_SERVER picks the target ("local" | "maincloud"); STDB_HTTP overrides it.
    stdb_server: str = _env("STDB_SERVER", "local")
    stdb_http: str = _env("STDB_HTTP") or _SERVERS.get(_env("STDB_SERVER", "local"), _SERVERS["local"])
    stdb_db: str = _env("STDB_DB", "wildfire-rescue")
    agent_join_key: str = _env("AGENT_JOIN_KEY", "dev-join-key")
    operator_passcode: str = _env("OPERATOR_PASSCODE", "dev-passcode")

    # Agent identities on Fetch are derived from seeds. Changing the prefix
    # changes every agent address, so keep it stable (and secret).
    seed_prefix: str = _env("AGENT_SEED_PREFIX", "wildfire-rescue-dev")
    # Which agents connect to Agentverse via mailbox (comma list of names,
    # or "all"). ASI:One-facing agents need it; internal ones work locally.
    mailbox_agents: str = _env("MAILBOX_AGENTS", "intake,commander")
    base_port: int = int(_env("AGENT_BASE_PORT", "8100"))
    # Agentverse handle prefix: agents get "@<prefix>-<name>" (what ASI:One's @ autocomplete
    # searches). Handles are globally unique, so pick something team-specific. Empty = no handle.
    handle_prefix: str = _env("AGENT_HANDLE_PREFIX")

    asi1_api_key: str = _env("ASI1_API_KEY")
    asi1_base_url: str = _env("ASI1_BASE_URL", "https://api.asi1.ai/v1")
    asi1_model: str = _env("ASI1_MODEL", "asi1-mini")

    # Fire agent: "sim" = simulated spread only; "firms" = NASA FIRMS detections + simulated
    # spread between satellite passes. FIRMS_DATE (YYYY-MM-DD) replays a historical fire.
    fire_source: str = _env("FIRE_SOURCE", "sim")
    firms_map_key: str = _env("FIRMS_MAP_KEY")
    firms_product: str = _env("FIRMS_PRODUCT", "VIIRS_SNPP_NRT")
    firms_date: str = _env("FIRMS_DATE")
    firms_days: int = int(_env("FIRMS_DAYS", "1"))
    # Weather agent: "nws" = live National Weather Service observations; "scenario" = leave
    # the scenario/commander wind alone and only report.
    weather_source: str = _env("WEATHER_SOURCE", "nws")
    weather_poll_s: float = float(_env("WEATHER_POLL_S", "300"))

    # News agent: "file" replays NEWS_FIXTURE (free), "brightdata" runs the
    # Scraper Studio collector (billed per page load), "off" disables it.
    # Delegation (head) agent: how often it pools the hazard + news reports into a situation.
    # Dispatch policy the delegation (head) agent runs: nearest | greedy | lookahead | learned.
    # nearest | greedy | lookahead: heuristic placeholders. rl: the RL component, rescue/rl_policy.py.
    policy: str = _env("POLICY", "lookahead")
    situation_period_s: float = float(_env("SITUATION_PERIOD_S", "30"))
    news_source: str = _env("NEWS_SOURCE", "file")
    brightdata_api_key: str = _env("BRIGHTDATA_API_KEY")
    brightdata_collector_id: str = _env("BRIGHTDATA_COLLECTOR_ID")
    news_keywords: str = _env("NEWS_KEYWORDS", "wildfire,evacuation,road closure")
    news_location: str = _env("NEWS_LOCATION", "Paradise California")
    news_places: str = _env("NEWS_PLACES", "Paradise,Magalia,Pentz,Concow,Chico,Butte County")
    news_poll_s: float = float(_env("NEWS_POLL_S", "1800"))
    # Send date_from/date_to (YYYY-MM-DD) to the Bright Data collector. Leave 0 unless the collector
    # declares those inputs: an input the collector doesn't know about is rejected (HTTP 422).
    news_send_dates: bool = _env("NEWS_SEND_DATES", "0") in ("1", "true", "yes")
    news_archive_dir: str = _env("NEWS_ARCHIVE_DIR", "news_archive")
    news_fixture: str = _env("NEWS_FIXTURE", "fixtures/brightdata_cnn_sample.json")
    nws_user_agent: str = _env("NWS_USER_AGENT", "wildfire-rescue-queue (calhacks demo)")

    @property
    def stdb_ws(self) -> str:
        return self.stdb_http.replace("http://", "ws://").replace("https://", "wss://")

    def uses_mailbox(self, agent_name: str) -> bool:
        names = {n.strip() for n in self.mailbox_agents.split(",") if n.strip()}
        return "all" in names or agent_name in names


settings = Settings()
STATE_DIR.mkdir(exist_ok=True)
