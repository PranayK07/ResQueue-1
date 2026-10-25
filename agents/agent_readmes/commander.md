# Wildfire Rescue Queue — commander agent

![tag:innovationlab](https://img.shields.io/badge/innovationlab-3D8BD3)
![tag:hackathon](https://img.shields.io/badge/hackathon-5F43F1)

The head agent of a multi-agent wildfire rescue system. It orchestrates three subagents (**hazard**, **news**, **intake**), merges what they report into one picture, decides how dangerous each distress signal is, and places each person in the right fire station's queue. This is the agent to talk to in ASI:One.

> Simulated demo on a recorded real 2020 wildfire. Residents, stations and units are synthetic. Decision support for an incident commander, never a replacement for 911.

## What it does

A distress signal comes in. The commander turns it into a decision: **danger level, station, queue rank, unit and ETA**, and shows which agent contributed what.

| Question | Answered by |
|---|---|
| Where is the fire, how fast is it moving, how soon does it reach this spot? | **Hazard agent**: recorded fire perimeter, wind, a physical ensemble forecast and a trained U-Net spread model |
| What do official sources say (evacuations, road closures, containment)? | **News agent**: trusted wildfire accounts on X, via Bright Data |
| What is this person telling us, and how much should we believe it? | **Intake agent**: text, voice transcript, photos and video read into structured claims; the commander then weighs them |
| Who goes first, and from which station? | **Commander**: danger and slack engine, then the dispatch policy |

## Architecture

```
                              ASI:One chat
                                   │  Agent Chat Protocol
                                   ▼
        ┌──────────────────  COMMANDER (head agent)  ──────────────────┐
        │  reports engine → danger engine → risk composer → planner      │
        └───▲──────────────────▲──────────────────▲──────────┬──────────┘
            │ HazardReport     │ NewsReport       │ Assessment│ SignalRequest
            │ (uAgents msgs, request / reply)     │ + Ack     ▼
      ┌─────┴─────┐      ┌─────┴─────┐      ┌─────┴─────────────┐
      │  HAZARD   │      │   NEWS    │      │      INTAKE       │◄── resident pings
      │ fire+wind │      │ X posts   │      │ reads reports into │    (app or chat)
      │ U-Net     │      │ Bright    │      │ structured claims  │
      └─────┬─────┘      │ Data      │      └─────┬─────────────┘
            │            └─────┬─────┘            │
            ▼                  ▼                  ▼
   ┌───────────────────────────────────────────────────────────────┐
   │ SpacetimeDB: shared live world state (tables, views, reducers) │
   │ fire, weather, forecast, news, requests, risk, queues          │
   └───────────────────────────────────────────────────────────────┘
```

Agents share state through **SpacetimeDB** and talk directly with **typed uAgents messages** where they need an answer back.

### How the subagents talk to the commander

| From → to | Message | Purpose |
|---|---|---|
| commander → hazard | `HazardReportRequest` → `HazardReport` | Fire size, heading, per-station fire ETA, wind |
| commander → news | `NewsReportRequest` → `NewsReport` | Top relevant posts and extracted signals |
| commander → intake | `IntakeReportRequest` → `IntakeReport` | Reading health and backlog |
| commander → intake | `SignalRequest` → `SignalAck` | Hand a distress signal to intake to be filed |
| intake → commander | `Assessment` → `AssessmentAck` | Structured claims for one request (re-sent until acknowledged) |

Every write goes through a validated SpacetimeDB reducer. The database, not any agent, enforces the rules: a commander pin beats the policy, a committed unit is never reassigned, and a resident only ever sees their own card.

### How a decision is made

1. **Intake** reads everything a request sent (text, voice transcript, photos, video frames) into claims: people, needs, trapped, injured, fire seen and how far, road blocked, confidence.
2. The **commander weighs the claims** against the hazard model and against neighbours. A text-only claim moves the queue only a little. A corroborated or media-backed claim moves it more.
3. **Danger engine:** slack = fire arrival (the physical forecast, or sooner if a credible resident sighting says so) minus travel time minus extraction time, using time-dependent routing where roads close before the fire reaches them. Levels: moderate, high, critical, unreachable.
4. **Risk composer:** adds the trained U-Net's probability that the location is affected within hours, plus hints from the news agent. News hints and resident-versus-model disagreements appear as flags and never silently change the numbers.
5. **Planner:** every cycle it pools the three agents' reports into one situation and runs the dispatch policy to place each request in a station's queue, with a one-line reason.
6. If **no unit can arrive before the fire**, the request is escalated for other resources (air support, mutual aid) instead of being queued.

## Try it in ASI:One

No login is needed for `status`, `signal`, `reports`, `fire`, `weather`, `news` and `help`. Commands that change the simulation (`wind`, `pause`, `pin`, `refresh news`) need `login <operator passcode from .env>` (the demo's operator passcode).

```
status
```
Shows the pooled picture: one row per agent (hazard fire, hazard weather, news, intake, learned risk model) and every station's queue.

```
signal 35.6322 -112.7351 2 people elderly, smoke visible down the street, we can still drive out
```
Sends a mock distress signal through the whole pipeline. You get an instant acknowledgement, then the decision:

```
🚨 Decision for signal #77
- Danger:   HIGH — 31 min of slack after travel and extraction
- Station:  Synthetic station 1, rank 3 in its queue; Engine 2 dispatched, ETA about 9 min (policy: lookahead)
- Learned fire exposure: 38% within 24 h

How the agents got there
- Intake read it (keywords): elderly, smoke seen, no one trapped
- Commander weighed the claims: ...
- Hazard: fire 1.6 km², wind 5 m/s; learned model ready
- News: 0 relevant X post(s)
- Dispatch policy: ...
```
(The values above show the format. Real values depend on the live state.)

```
signal 35.6624 -112.7463 3 people mobility medical, flames behind the house, road blocked by a fallen tree, my mother is trapped and can't walk
```
A worse claim: higher danger, a higher place in the queue.

```
wind 5 from 0
```
Changes the wind. The hazard agent re-runs the forecast and the commander rescores everything.

```
reports
```
For each resident report: how much of it was accepted and what it did to the queue.

Other commands: `fire`, `weather`, `news`, `refresh news`, `track <x.com post>`, `incident`, `ping <lat> <lon> <place>`, `window <from> <to>`, `pin <id> to <station>`, `unpin <id>`, `pause`, `resume [x]`, `release wind`, `help`.

## The data

The replay is a real 2020 wildfire in northern Arizona (about 35.65 N, 112.73 W), recorded as NIROPS aerial infrared perimeters from 2020-07-08 to 2020-07-14 (1.6 km² at the start, 6.4 km² at the end). Only observations the replay clock has reached are visible to the model. Two stations, four units and 24 residents are synthetic and placed inside the fire's area.

## Honest limits

- Stations, units and residents are synthetic. Travel is a grid approximation of roads.
- The dispatch policy is a lookahead heuristic. The learned part is the fire forecast.
- Intake reads reports with an open vision-language model when one is configured, and falls back to keyword matching offline.
- Exposure estimates cover 6 to 72 hours. They do not claim minute-level arrival times.

## Run it

See the repository README: publish the SpacetimeDB module, seed the recorded incident, start the agents, and connect the commander's mailbox through its Agent Inspector link.

Part of a multi-agent system coordinating through a shared SpacetimeDB world state.
