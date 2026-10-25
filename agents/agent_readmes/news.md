# Wildfire Rescue Queue — news agent

![tag:innovationlab](https://img.shields.io/badge/innovationlab-3D8BD3)
![tag:hackathon](https://img.shields.io/badge/hackathon-5F43F1)

Scrapes wildfire news (Bright Data) and extracts evacuation orders, road closures, containment and acreage for the commander.

Scraped articles are stored in a shared SpacetimeDB table; signals are hints for the human incident commander, never applied automatically.
