# Wildfire Rescue Queue: notes for Claude Code

Frontend lane (Evan). Branch: `frontend`. Push only to `origin frontend`. Never push to `main`, never force-push, no PR unless Evan asks.

- `claude/frontend-spec.md` is the source of truth for the frontend. Its section 0 rules always apply.
- `claude/kickoff-prompt.md` has the build workflow. Re-read it at the start of a new session.
- `claude/frontend-preview.png` is a rough look reference only. Figma wins.
- Subagents in `.claude/agents/`: figma-reader, ui-builder, spec-guard, screen-tester, guide-writer.
- Frontend work never edits `spacetimedb/`, `agents/` or `scripts/`. Contract problems go in `claude/frontend-gaps.md`.
- `AGENTS.md` holds SpacetimeDB's official rules (mostly server side). Check it for SDK questions.
- Docs and UI copy: no em dashes.
