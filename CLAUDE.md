# Wildfire Rescue Queue: notes for Claude Code

Frontend lane (Evan). Branch: `frontend`. Push only to `origin frontend`. Never push to `main`, never force-push, no PR unless Evan asks.

- `claude/frontend-spec.md` is the source of truth for the frontend. Its section 0 rules always apply.
- `claude/kickoff-prompt.md` has the build workflow. Re-read it at the start of a new session.
- `claude/frontend-preview.png` is a rough look reference only. Figma wins.
- Subagents in `.claude/agents/`: figma-reader, ui-builder, spec-guard, screen-tester, guide-writer.
- Frontend work never edits `spacetimedb/`, `agents/` or `scripts/`. Contract problems go in `claude/frontend-gaps.md`.
- Regenerate bindings after any `spacetimedb/src` change: `spacetime generate --lang typescript --out-dir web/src/module_bindings --module-path spacetimedb` (or `npm run bindings` in `web/`), and commit them in the same push.
- `AGENTS.md` holds SpacetimeDB's official rules (mostly server side). Check it for SDK questions.
- Docs and UI copy: no em dashes.

## Rulings from Evan (Oct 24)

These override the spec, `kickoff-prompt.md` and the agent files wherever they conflict.

- Figma is out of the build. Build every screen from the spec, with `claude/frontend-preview.png` and the spec tokens for the look. Ignore spec rule 0.1, any "stop if a Figma frame is missing" rule and `// FIGMA: pending` markers. Don't run figma-reader; ui-builders get briefs written from the spec; screen-tester skips the Figma comparison. Finished screens go into Figma later as a separate step.
- `claude/frontend-shapes.md` overrides the spec on contract details. Shell exports use its names (`useTable`, `useView`, `call`, `login`, `cellCenter`, `cellPolygon`, `insideGrid`, `minsFromNow`); the spec's folder paths under `web/src` stay. Other differences are logged in `claude/frontend-gaps.md`.
- The [confirm] reducers are in the shapes contract: the `FEATURES` flags stay but default ON.
- `unit_en_route`: `freeAtS = arriveAtS + extractS + (arriveAtS - simS)`.
- Intake: parse while the person types (debounced), Send never waits, parsed fields show as editable chips before Send. Off until `VITE_INTAKE_URL` is set.
- The danger, delegation and station agents are still stubs. Checklist items that need queues, levels, wind reorder, flags or the /crew mission flow are BLOCKED-BACKEND, not FAIL. A screen is done when everything else passes and spec-guard passes. Never fake data to get around it.
- The local backend from `scripts/dev.sh` is Evan's sandbox: never stop or restart it. The demo connects to a hosted database, so every connection setting stays in `VITE_*` env vars.
