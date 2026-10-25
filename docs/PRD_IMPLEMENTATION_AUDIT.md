# PRD traceability and independent implementation audit

Source: unmodified `Wildfire Rescue Queue_ PRD.pdf`, draft October24, 2:15PM
(six pages, with later changelog notes). This audit rereads the complete PDF
against `dcaaf5b` and the independent forecasting branch. “Preserved” means
existing code remains; it does not mean this task newly implemented or tested
every external workflow. Executed evidence is recorded in the benchmark and
verification receipts, separately from source inspection.

| PRD requirement | Page / section | Owner in draft | Implementing module | Test / evidence | Status and discrepancy |
|---|---|---|---|---|---|
| Resident help, consent, safe cancellation and status card | p1–3 How it works / Must | Evan, Sharon | Existing intake; SpacetimeDB request reducers and `my_requests` | Isolated DB demo checks owner cards and revocation purge | Backend preserved; React app absent on baseline; full phone flow unverified |
| QR demo persona inside incident area | p2–3 Demo / Must | Evan | Existing scenario/seed files; new synthetic-only integration demo | Seeded residents in recorded-fire domain | Forecast demo implemented; QR frontend not implemented |
| Claude field parsing, one-tap confirm and3s fallback | p2 Under hood / p3 Must | Sathvik wiring, Evan prompts | Existing `agents/intake.py` | Source inspection: free-text intake TODO | Unimplemented Must; no Anthropic/timeout implementation added in this focused branch |
| Danger/slack for every request | p2 Rank / p3 Must | Pranay, Q2 unresolved | Existing `core/danger.py`, `slack.py`; optional `risk.py` and danger seam | Core planning test, risk/integration tests, DB publish_danger | Existing short-horizon path preserved; coarse learned uncertainty kept separate |
| Station queues, deterministic reasons and simulated crews | p2 Assign / p3 Must | Sathvik, Q2 unresolved | Existing Lookahead/planning/delegation; station stub | Pure tests + actual isolated publish_plan/subscriptions | Queues implemented; automated station mission execution remains missing |
| Commander map, wind, flags, pins, event log | p3 Must | Evan | Existing reducers; optional geographic risk tables | Isolated wind-change and pin/committed-mission checks | Backend preserved; commander frontend missing |
| ASI:One intake/commander chats | p3 Must / p4 Tracks | Sathvik | Existing Fetch.ai mesh/chat/messages | Source inspection only in this task | Preserved; Agentverse/ASI:One not launched with credentials here |
| Scoreboard vs first-come and nearest on200 independent unseen fires | p3 Demo / Must | Pranay | Existing nearest/greedy/Lookahead; new **fire forecast** benchmarks | Frozen incident-group forecast evaluation | Not the PRD rescue scoreboard. First-come rescue baseline absent;105 eligible historical test groups/303pairs are not200 independent fires |
| Intake evaluation50+ known messages, no missed assistance needs | p3–4 Must | Evan, Pranay | No new intake evaluator | Source inspection | Missing Must; not supplied by fire segmentation metrics |
| Learned delegation ships only if it beats Lookahead | p4 Must | Pranay, Q3 unresolved | Preserved assignment plug-in; Lookahead remains default | No rescue-policy retraining | Gate preserved. Supervised fire forecasting is the explicit ML amendment and cannot be compared to Lookahead using segmentation IoU |
| Consent location deletion at window end/close | p2 Design choices / p5 Contract | Database / team | Existing `expire_consent`, `closeRequest` | Revocation verified against actual local DB; timer inspected | Cancellation purge passed. Existing locked missions autoextend consent15min, contradicting literal expiry requirement; unchanged and needs owner decision |
| Language model explains, never ranks or invents numbers | p2 / p5 Guardrails | Sathvik, Evan | Existing deterministic plan reasons; new numeric risk reasons | Deterministic reason tests | New path deterministic; original Claude intake remains absent |
| Resident/station/operator access scope | p2 Privacy / p5 Contract | Database / frontend | Existing private tables, sender views; new geographic-only public risk | Real DB owner-card/hazard-no-people checks | Preserved; new tables contain no request IDs or resident locations |
| Same shared live state; commander pin wins; sent crew retained | p2 / p5 Contract | Sathvik | Existing transactional reducers and views | Isolated publication, wind update, pin and committed-unit checks | Backend contracts tested; complete live UI/mesh not claimed |
| Event log on commander map | p4 Should1 | Evan | Existing event_log backend | Local reducer log exists | Preserved backend; map missing |
| Reasons translated via Claude | p4 Should2 | Sathvik | No change | Not tested | Deferred |
| Crew phone `/crew` | p4 Should3 | Sharon, Evan | No frontend added | Not tested | Deferred |
| Real OSM road graph | p4 Should4 | Pranay | Existing grid router preserved | Grid routing tests | Deferred; roads explicitly simulated |
| Camp Fire NASA replay | p4 Should5 | Pranay | Existing FIRMS adapter preserved | Keyed live ingestion not run | Deferred; NIROPS study covers2020–24, not Camp Fire2018 |
| Commander Claude Q&A from numbers | p4 Should6 | Sathvik | Existing typed chat scaffolding | Not live-tested | Deferred |
| Tracking, drones/cameras, SMS, inter-station negotiation, terrain/fuel maps, custom design system | p4 Cut | Team | No additions | Diff audit | Cut preserved; synthetic fuel is existing simulator input, not measured historical fuel |
| Hardware/help button | p6 Hypothetical | Team | No addition | Diff audit | Cut preserved |
| Radio idea | p5–6 / Q5 | Pranay | No addition | User explicitly scrapped it | Removed from scope; Q5 treated as resolved by user instruction |

## Proposed amendment and shared contract changes

The new task explicitly makes wildfire forecasting the ML responsibility. A time-conditioned U-Net
learns future footprint probabilities from real observed perimeter pairs;
Lookahead continues resource allocation. The PRD's learned-delegation gate
remains intact for the separate preserved dispatcher experiment. Team acceptance
of this amendment is not assumed.

Existing table columns/reducer signatures and role views are unchanged. Physical
forecast publication now rejects stale weather/fire versions and future issue
times; this focused correction closes an observed validation gap without adding
arguments. Learned fire configuration keeps delegation on Lookahead. New
`fire_risk_meta`, `fire_risk_cell` and `publish_fire_risk` add an optional public
geographic probability layer with explicit clock/CRS/horizon. New agent
subscriptions require the extended module to be published. Frontend owners must
decide how to show coarse intervals/review states before subscribing. The live
default stays simulation. The former forecasting workstream was replaced with supervised U-Net. No Maincloud configuration was changed.

Main's static scheduling score and station stubs do not establish completed
handoff, return-route safety or realized release time. The demo reports static
extraction projections separately and leaves completed handoffs undefined.
Capacity/capability limits in `PlanInput` remain a blocker for heterogeneous
fleet claims. Main cancellation/mission-completion release semantics also need
station-owner review; no earlier experimental fixes were imported.

## Unresolved questions and contradictions

Q1 (Claude vs ASI:One parsing), Q2 (agent wiring ownership), Q3 (learned-policy
owner), Q4 (judging host), Q6 (resident channel), Q7 (name), Q8 (Monday usability)
and Q9 (firsthand voice) remain team decisions. Q5 radio is scrapped by the user.
No code here claims those decisions were approved.

The PRD says three agents and mentions voice in its tech stack, while the
repository has a larger mesh and the scoped feature list does not authorize a
new voice build. The PRD also calls danger/delegation empty although main now
implements them. The PRD's “no changes proposed” database contract is reconciled
by additive tables, not by changing existing fields. Its200-fire demo number
cannot be presented as achieved by re-labeling303 pairs from105 groups.

## Second independent audit

Separate ETL and RL reviewers verified parent grouping, timestamp ordering,
grid orientation, causal features, solver equivalence and inference boundaries.
They found and corrected concrete parent-complex leakage **before final-test
evaluation**, plus mismatched geographic metadata and expired-risk edge cases.
The retired forecasting implementation and artifacts were removed; supervised models initialized fresh. No
future observation or resident demand is an action feature. Core fire, router,
slack, Lookahead and mission code remain from main. Remaining Must gaps above
are explicit, rather than inferred complete from implementation scaffolding.

Final executed test counts, frozen measurements, activation recommendation and
live-integration limitations are in the benchmark report and verification JSON.
