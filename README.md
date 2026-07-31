# Agent QA Kanban

Agent QA Kanban is an open Agent Skill that combines three workflows:

1. evidence-led regression and exploratory QA
2. a live kanban view of every QA card
3. append-only learning from explicit human QA feedback

The board JSON is the source of truth. Host-specific renderers turn the same
board into a Codex inline visualization, a Cursor Canvas beside chat, a
standalone/Claude HTML artifact, or a Markdown fallback.

## Preview

### Compact six-column board (HTML / Codex)

![Agent QA Kanban compact board with six status columns](./assets/qa-kanban-example.png)

The overview keeps all six statuses in one horizontal row. Each column scrolls
vertically while the board wrapper owns horizontal scrolling.

### Card detail dialog (HTML / Codex)

![Agent QA Kanban card detail dialog](./assets/qa-kanban-detail-dialog.png)

Selecting a compact card opens its full evidence, diagnosis, and next action in
a read-only dialog instead of extending the board page.

_Both HTML previews are rendered from `examples/qa-board.example.json` at the
same viewport and contain synthetic data only._

### Cursor Canvas beside chat

When this skill is installed for Cursor and the agent runs in Cursor with
Canvas available, the board opens as a **Canvas** beside the chat (side/right
panel). This is not a Codex thread HTML fragment.

Card selection opens a full-width detail panel below the board. Compact cards
show `severity` and `classification`; the detail panel shows `resolution`,
`severity`, and `change_scope`, plus summary / surface / next action and
**Copy continue prompt**. Columns scroll vertically only; the board scrolls
horizontally only. There is no drag-and-drop and no status-changing control —
canonical updates stay in `qa-board.json`.

To preview the current Cursor surface, generate from
`examples/qa-board.example.json` with `scripts/hosts/cursor-canvas.mjs` and
open the resulting `.canvas.tsx` in Cursor. Do not treat synthetic marketing
images as runtime evidence for this host.

## Why this exists

QA execution skills, kanban task managers, and interactive artifact builders
usually exist as separate tools. This skill joins them without making the UI
the system of record:

- every finding has a stable card ID, status, classification, evidence, and
  next action
- cards move through `queued`, `investigating`, `fixing`, `verifying`, `done`,
  or `blocked`
- a card cannot be marked done without verification evidence
- human feedback is learned separately from agent-discovered findings
- human learning is appended only when repository policy or the user authorizes it
- unsupported hosts still receive a complete Markdown board

## Install

### General

Install for Agent Skills-compatible hosts:

```bash
npx skills add jadeonstudio/agent-qa-kanban --skill agent-qa-kanban
```

Or copy `skills/agent-qa-kanban` into the skill directory used by your agent.

### Cursor

Install explicitly for Cursor so the skill is discoverable under Cursor skill
paths (`.cursor/skills`, `.agents/skills`, and the matching user homes):

```bash
npx skills add jadeonstudio/agent-qa-kanban --skill agent-qa-kanban -g -a cursor -y
```

Cursor Canvas appears only when **all** are true:

1. the skill is installed on a Cursor/.agents skill path
2. the built-in Canvas host skill is available
3. the current agent process is a Cursor runtime session
   (`CURSOR_AGENT` / `CURSOR_CONVERSATION_ID`)

If any check fails, the skill falls back to Markdown (printed to stdout by the
Cursor renderer when `--markdown-out` is omitted) and must not claim a Canvas
board. See `skills/agent-qa-kanban/references/cursor-host.md`.

## Use

Example requests:

```text
Use $agent-qa-kanban to QA the checkout flow and keep the findings in an inline kanban.
```

```text
Use $agent-qa-kanban in audit-only dual-lane mode. Read our human QA log first,
then expand into adjacent routes and APIs.
```

```text
Continue QA-004, fix it, rerun the same scenario, and move the card only when
the evidence proves it.
```

On Cursor after install:

```text
Use $agent-qa-kanban, validate the board, and render the Cursor Canvas kanban.
```

## Board utilities

The utilities are dependency-free Node.js scripts.

```bash
node skills/agent-qa-kanban/scripts/validate-board.mjs \
  examples/qa-board.example.json

node skills/agent-qa-kanban/scripts/render-board.mjs \
  examples/qa-board.example.json \
  .tmp/qa-board-fragment.html \
  --mode fragment

node skills/agent-qa-kanban/scripts/render-board.mjs \
  examples/qa-board.example.json \
  .tmp/qa-board.html \
  --mode standalone

node skills/agent-qa-kanban/scripts/render-markdown.mjs \
  examples/qa-board.example.json \
  .tmp/qa-board.md

node skills/agent-qa-kanban/scripts/hosts/cursor-capabilities.mjs

node skills/agent-qa-kanban/scripts/hosts/cursor-canvas.mjs \
  examples/qa-board.example.json \
  --out .tmp/qa-kanban-example.canvas.tsx \
  --report .tmp/cursor-render-report.json
```

Record a validated human-feedback entry:

```bash
node skills/agent-qa-kanban/scripts/validate-human-learning.mjs \
  examples/human-feedback.example.json

node skills/agent-qa-kanban/scripts/record-human-learning.mjs \
  .qa-kanban/human-qa-learning.jsonl \
  examples/human-feedback.example.json
```

The recorder rejects agent-only observations, duplicate IDs, dangerous object
keys, and entries that are not explicitly marked as redacted.

## Development

```bash
npm test
npm run validate:example
npm run validate:human-example
npm run render:example
npm run probe:cursor
npm run render:cursor
```

No product server, browser, database, or external service is started by these
commands.

## Portability

The Agent Skills workflow is portable, but UI bridges are host-specific.

| Host capability | Output |
| --- | --- |
| Codex inline visualization | HTML fragment plus host inline directive |
| Cursor Agent (skill installed + Canvas host + Cursor runtime) | Canvas beside chat (embedded board snapshot) |
| HTML/Artifact-capable agent | standalone CSP-protected HTML |
| File preview only | standalone HTML |
| No HTML/Canvas surface | Markdown board |

Interactive controls are only rendered when a working host callback exists.
The board deliberately does not provide drag-and-drop because a visual move
that does not update the canonical JSON would be misleading.

## License

MIT
