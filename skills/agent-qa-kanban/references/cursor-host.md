# Cursor host adapter

Production notes for **Cursor Agent / Cursor IDE** board rendering.

Cursor does **not** provide a Codex-style thread HTML visualization bridge.
When this skill is installed for Cursor **and** the current process is a Cursor
runtime session **and** Canvas is available, the board is rendered as a
**Canvas** beside the chat. Otherwise use Markdown and do not claim a canvas
board.

## Gate (all required)

1. **Cursor skill install** — `SKILL.md` exists under one of:
   - project: `.cursor/skills/agent-qa-kanban/` or `.agents/skills/agent-qa-kanban/`
   - user: `~/.cursor/skills/agent-qa-kanban/` or `~/.agents/skills/agent-qa-kanban/`
2. **Cursor Canvas host** — built-in Canvas skill present at
   `~/.cursor/skills-cursor/canvas/SKILL.md`
3. **Cursor runtime session** — at least one of:
   - `CURSOR_AGENT` is set
   - `CURSOR_CONVERSATION_ID` is set
   - process exec path contains `cursor-agent`

File presence alone is not enough. A Codex/Claude session on a machine that
merely has Cursor installed must fall back to Markdown.

Never treat an unverified PATH `agent` binary as Cursor Agent (avoids
Grok/other CLI confusion).

## Install for Cursor

General Agent Skills install (multi-host copy):

```bash
npx skills add jadeonstudio/agent-qa-kanban --skill agent-qa-kanban
```

Cursor-targeted install (explicit agent flag):

```bash
npx skills add jadeonstudio/agent-qa-kanban --skill agent-qa-kanban -g -a cursor -y
```

Project-scoped installs may land under `.agents/skills` and/or `.cursor/skills`.
The probe accepts both. Do **not** install user skills into
`~/.cursor/skills-cursor/` (built-ins only).

## Surfaces

| Surface | When | Notes |
| --- | --- | --- |
| `cursor-canvas` | Gate passed | Embedded board snapshot in `.canvas.tsx` beside chat |
| `markdown-fallback` | Gate failed | Full Markdown board on stdout (or `--markdown-out`) |

Canonical state remains `qa-board.json`. Output paths (`--out`,
`--markdown-out`, `--report`) must not alias the board via the same
resolved path, symlink, or hardlink, and must not share identity with
each other.

Canvas UX:

- outer board: horizontal scroll only
- columns: vertical scroll only (`overflowX: hidden`)
- card detail: full-width panel below the board (Canvas side panels clip
  absolute modals; normal-flow detail stays readable)
- when a card is open, the board height shrinks to leave room for detail
- **Copy continue prompt** copies an allowlisted payload for paste into the
  current chat (no same-thread auto-send API on Cursor)

## Entrypoints

```bash
node <skill-dir>/scripts/hosts/cursor-capabilities.mjs

node <skill-dir>/scripts/hosts/cursor-canvas.mjs \
  <qa-board.json> \
  --out ~/.cursor/projects/<workspace>/canvases/qa-kanban-<run-id>.canvas.tsx \
  --report <report.json>
```

Useful flags:

- `--force` — bypass gate for tests; do not use in normal skill workflow
- `--markdown-out <path>` — write Markdown when falling back

When the gate fails and `--markdown-out` is omitted, the CLI prints the
Markdown board to stdout.

## Agent workflow

1. Validate `qa-board.json`.
2. Run the Cursor capability probe (or `cursor-canvas.mjs` which probes).
3. If `selectedSurface` is `cursor-canvas`, write the `.canvas.tsx` under the
   workspace `canvases/` directory and link it for the user.
4. If fallback, render/print Markdown and say so honestly.
5. Re-render the Canvas after meaningful board status changes.

See also [host-adapters.md](host-adapters.md).
