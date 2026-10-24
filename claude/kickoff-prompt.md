You're building the frontend for Wildfire Rescue Queue (Cal Hacks 13.0) in this repo. I added:
- `claude/frontend-spec.md`: the full spec and the source of truth. Section 0 has the rules. Follow them exactly.
- `claude/frontend-preview.png`: a rough mock of the look. Figma wins over it. Use it only for the Jimo-style guide layer, which isn't in Figma.
- `.claude/agents/`: five subagents (below). `CLAUDE.md`: short standing notes.

## 1. Branch first
1. `git fetch origin`
2. If `origin/frontend` exists: `git switch frontend && git pull --rebase origin frontend`. Otherwise: `git switch -c frontend origin/main`.
3. Commit the files above on `frontend` ("chore: add frontend spec and subagents") and `git push -u origin frontend`.

All work stays on `frontend`. Commit each time a phase passes its checks, then push to `origin frontend`. Never push to `main`, never force-push, and don't open a PR unless I ask. If a push is rejected (permissions or branch protection), stop and tell me. When `origin/main` gets backend changes, merge `origin/main` into `frontend` and regenerate the bindings.

## 2. Subagents (use them; they keep your context small)
- **figma-reader**: reads one Figma frame through the Figma MCP and returns a build brief (layout, components mapped to the spec, copy, states, conflicts such as the "Canyon" station name). Run it before building each screen.
- **ui-builder**: builds presentational components for one screen region from that brief. Run several in parallel, one per region, each owning its own folder. It doesn't wire data; you do.
- **spec-guard**: read-only reviewer. Run it before every commit. Don't commit on FAIL.
- **screen-tester**: runs a screen's test checklist (typecheck, build, Playwright against the seeded local DB, screenshots compared with Figma). Run it when a screen is done.
- **guide-writer**: writes the guide steps in phase 5 and checks every anchor exists.

You own the shell (`web/src/lib`), data wiring, integration and git. Don't hand the shell to a subagent.

## 3. Read before coding
1. `claude/frontend-spec.md`, all of it.
2. `claude/frontend-shapes.md` if it exists. It overrides contract details; log any differences in `claude/frontend-gaps.md`.
3. `spacetimedb/src/schema.ts` and `spacetimedb/src/index.ts`.

## 4. Prereqs (check, don't guess)
- Figma MCP is connected (`/mcp`). If not, stop and tell me.
- SpacetimeDB CLI installed and the local DB seeded. From the repo root: `MAILBOX_AGENTS=none scripts/dev.sh reset` (needs `.env` with `AGENT_JOIN_KEY` and `OPERATOR_PASSCODE`). If it isn't running, give me the command. Never mock data instead.
- `web/.env.local` (make sure it's gitignored): `VITE_STDB_URI=ws://127.0.0.1:3000`, `VITE_STDB_DB=wildfire-rescue`, `VITE_INTAKE_URL=` (empty for now). For `VITE_MAP_STYLE_URL`, default to CARTO Dark Matter (`https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json`, no key, keep its attribution) unless I say otherwise.
- Bindings: `spacetime generate --lang typescript --out-dir web/src/module_bindings --module-path spacetimedb`. Commit them. Never hand-edit them.

## 5. Build (spec section 5)
Phase 1 shell, phase 2 /help, phase 3 /command, phase 4 /crew, phase 5 guide content.

For each screen: figma-reader, then ui-builders in parallel, then you wire data through the shell, then screen-tester, then spec-guard, then commit and push.

After each phase, send me 3 lines: what works, what's blocked, what you need from me.

## 6. Stop and ask me when
- A Figma frame is missing for /command or /crew. (/help may not have one yet. In that case, build from the spec with `// FIGMA: pending` markers and keep going.)
- The backend lacks something you need. Write it in `claude/frontend-gaps.md`; never edit `spacetimedb/`, `agents/` or `scripts/`.
- A reducer tagged [confirm] needs turning on. Those stay behind `FEATURES` flags until Sathvik confirms.

Start now with step 1, then the prereqs.
