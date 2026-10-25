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


def _path_env(name: str) -> str:
    raw = _env(name)
    if not raw:
        return ""
    path = Path(raw).expanduser()
    return str(path if path.is_absolute() else REPO_ROOT / path)


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
    # Learned forecasting is an optional coarse historical risk layer. The
    # existing physical forecast still supplies short-horizon route timing.
    fire_forecast_backend: str = _env("FIRE_FORECAST_BACKEND", "simulation")
    fire_forecast_checkpoint: str = _path_env("FIRE_FORECAST_CHECKPOINT")
    fire_forecast_metadata: str = _path_env("FIRE_FORECAST_METADATA")
    recorded_incident_path: str = _path_env("RECORDED_INCIDENT_PATH")
    fire_forecast_horizons_s: str = _env("FIRE_FORECAST_HORIZONS_S", "21600,43200,86400")

    # Commander (head) agent: the dispatch policy it runs, and how often it pools hazard + news + field reports
    # into a situation. nearest | greedy | lookahead: heuristic placeholders. rl: the RL component, rescue/rl_policy.py.
    policy: str = _env("POLICY", "lookahead")
    situation_period_s: float = float(_env("SITUATION_PERIOD_S", "30"))

    # Intake agent: how residents' text / voice transcripts / photos / video frames are read.
    #   hf       = an open vision-language model on Hugging Face via Inference Providers (needs HF_TOKEN)
    #   keywords = text only, offline (also the fallback when a model call fails)
    hf_token: str = _env("HF_TOKEN")
    intake_analyzer: str = _env("INTAKE_ANALYZER", "hf" if _env("HF_TOKEN") else "keywords")
    intake_model: str = _env("INTAKE_MODEL", "Qwen/Qwen3-VL-30B-A3B-Instruct")
    intake_concurrency: int = int(_env("INTAKE_CONCURRENCY", "4"))
    # The commander holds a new request out of the queue until its reports are read, for at most this long.
    intake_grace_s: float = float(_env("INTAKE_GRACE_S", "20"))

    # News agent: trusted wildfire accounts on X, read through Bright Data's X Posts scraper. "file" replays
    # NEWS_FIXTURE (free), "brightdata" runs the scraper (billed per post returned), "off" disables it.
    news_source: str = _env("NEWS_SOURCE", "file")
    brightdata_api_key: str = _env("BRIGHTDATA_API_KEY")
    brightdata_x_dataset_id: str = _env("BRIGHTDATA_X_DATASET_ID", "gd_lwxkxvnf1cynvib9co")
    # Registry of trusted accounts and the area each covers; the agent follows the ones near the incident.
    news_sources_file: str = _env("NEWS_SOURCES_FILE", "news_sources.json")
    news_accounts: str = _env("NEWS_ACCOUNTS")  # extra handles always followed (comma list)
    news_max_accounts: int = int(_env("NEWS_MAX_ACCOUNTS", "8"))
    news_posts_per_account: int = int(_env("NEWS_POSTS_PER_ACCOUNT", "20"))
    news_places: str = _env("NEWS_PLACES", "Paradise,Magalia,Pentz,Concow,Chico,Butte County")
    # Live mode (no incident selected) keeps posts from the last NEWS_LIVE_LOOKBACK_H hours.
    news_live_lookback_h: float = float(_env("NEWS_LIVE_LOOKBACK_H", "72"))
    # A location ping (ping_news) or incident change pulls the accounts near it that aren't on file yet for that
    # time window. 0 = only re-score what's stored, and pull on "refresh news".
    news_fetch_on_ping: bool = _env("NEWS_FETCH_ON_PING", "1") in ("1", "true", "yes")
    news_poll_s: float = float(_env("NEWS_POLL_S", "1800"))
    # Bright Data bills every run. Automatic scraping (on startup, on a timer) is OFF unless you set
    # NEWS_AUTO_SCRAPE=1; otherwise it scrapes only when asked ("refresh news", a ping), never more than the daily cap.
    news_auto_scrape: bool = _env("NEWS_AUTO_SCRAPE", "0") in ("1", "true", "yes")
    # A run is one Bright Data job: <= NEWS_MAX_ACCOUNTS x NEWS_POSTS_PER_ACCOUNT posts (8 x 20 at $1.50/1k ~ $0.24).
    news_max_scrapes_per_day: int = int(_env("NEWS_MAX_SCRAPES_PER_DAY", "10"))
    # With an incident selected, send its news window as start_date/end_date (NEWS_DATE_FORMAT) on each profile
    # input, so discovery returns posts from then instead of the newest ones. Leave 0 until you've confirmed
    # those input fields for "Discover by profile url" in the Bright Data dashboard: unknown inputs can be rejected.
    news_send_dates: bool = _env("NEWS_SEND_DATES", "0") in ("1", "true", "yes")
    news_date_format: str = _env("NEWS_DATE_FORMAT", "%m-%d-%Y")
    news_archive_dir: str = _env("NEWS_ARCHIVE_DIR", "news_archive")
    news_fixture: str = _env("NEWS_FIXTURE", "fixtures/news_sample.json")
    nws_user_agent: str = _env("NWS_USER_AGENT", "wildfire-rescue-queue (calhacks demo)")

    @property
    def stdb_ws(self) -> str:
        return self.stdb_http.replace("http://", "ws://").replace("https://", "wss://")

    def uses_mailbox(self, agent_name: str) -> bool:
        names = {n.strip() for n in self.mailbox_agents.split(",") if n.strip()}
        return "all" in names or agent_name in names


settings = Settings()
STATE_DIR.mkdir(exist_ok=True)
