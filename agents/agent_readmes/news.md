# Wildfire Rescue Queue — news agent

![tag:innovationlab](https://img.shields.io/badge/innovationlab-3D8BD3)
![tag:hackathon](https://img.shields.io/badge/hackathon-5F43F1)

Follows trusted wildfire accounts on X near the incident (CAL FIRE units, sheriffs and county OES, NWS offices, Caltrans, Red Cross) through Bright Data's X Posts scraper, and extracts evacuation orders, road closures, shelters and relief, containment and acreage for the commander.

Point it anywhere and at any time: a location ping (`ping_news`) sets where it looks, the incident row sets when (a past window such as autumn 2020, or live). Posts are scored by how trusted and how local their account is, stored in a shared SpacetimeDB table, and are hints for the human incident commander, never applied automatically.
