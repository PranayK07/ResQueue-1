# Native supervised forecast contract

`NativePredictor(checkpoint,metadata).forecast(history_masks, acquisition_s,
grid_record, horizons_s, valid)` consumes known chronological128² masks only.
`predict(sequence,pair)` passes a prefix ending at issue time; the target remains
outside features. Historical clocks are UTC seconds. Local UTM grids use meters,
row0south/column0west, and must match resident lookup geometry exactly.

Outputs are probability maps, horizons, model/version, native validation-selected
threshold, calibration assumptions and quality flags. No synthetic neural
ensemble or minute-level arrival fields are invented. Invalid cells are unknown;
current affected cells remain affected. Multi-horizon cumulative-max projection
enforces consistency without proving calibrated joint arrival probabilities.

Metadata binds feature schema `wildfire-supervised-known-perimeters-v2`, channel
order, train-only normalization, class counts/weight, analytic logit correction,
architecture, raw targets, archive/data/split hashes, dependency versions,
validation and timing. Parameter identity and checkpoint checksum are separate;
metadata mismatch rejects loading.

The live adapter requires explicit selection, native trained weights, matching
features/grid/horizons, validation/timing gates and known history. Simulation is
the default. Missing data/checkpoint or failed gates produces a visible reason.
The supported historical range6–72h cannot establish three-hour/minute timing;
existing physics continues supplying rescue route/slack times.

`ForecastProduct` uses `wildfire-risk-v1` and explicit issue/age/time basis.
A0.1 threshold crossing is bracketed only by supplied horizons; one map cannot
provide precise p10/p50 arrival minutes. Unknown, censored, revised and expired
forecasts require review. A model estimate never tells residents they are safe.

Additive SpacetimeDB tables contain no resident identifiers/locations. Typed
reducers authorize with `ctx.sender`, record `ctx.timestamp` and reject stale
weather/fire/clock snapshots captured before inference. Clients read tables and
subscriptions; reducers return no forecast data. Existing queues/views remain.
