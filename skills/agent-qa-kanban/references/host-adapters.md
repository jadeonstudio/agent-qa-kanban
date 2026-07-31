# Host adapters

The Agent Skill and board schema are portable. Inline rendering and follow-up
actions are host capabilities.

## Capability selection

Choose the first supported output:

1. host-provided inline HTML visualization (Codex)
2. Cursor Canvas beside chat (only when the Cursor gate passes — see below)
3. HTML/Artifact attachment
4. standalone HTML file preview
5. Markdown

Record the selected renderer in the final QA summary. Do not claim an inline
or Canvas board when only a file or Markdown was produced.

## Codex inline visualization

When the current Codex context provides a thread-scoped visualization
directory:

1. Render `--mode fragment` into that directory.
2. Read the fragment back and confirm it contains literal HTML rather than
   escaped markup.
3. Emit the host's exact inline visualization directive with the basename.
4. Keep the fragment under 2 MB.
5. Do not use fetch, XHR, WebSocket, external APIs, fixed positioning, or
   viewport-height layouts.

The renderer exposes a follow-up button only when
`window.openai.sendFollowUpMessage` exists. Card data remains untrusted and is
serialized as quoted data in the follow-up message.

The fragment and standalone document preserve `board.locale`. Korean (`ko*`)
uses Korean board labels; other locales currently use English labels while
retaining the declared document language. Agents must set `board.locale` from
the user's session language (Korean user → `ko`/`ko-KR`) before rendering; do
not leave a live Korean session on the English example default.

## Cursor Canvas

Cursor has no Codex-equivalent thread HTML bridge. When **all** are true:

1. `agent-qa-kanban` is installed under a Cursor/.agents skill path
   (`.cursor/skills`, `.agents/skills`, or the matching user homes)
2. the Cursor Canvas host skill exists
   (`~/.cursor/skills-cursor/canvas/SKILL.md`)
3. the current process is a Cursor runtime session
   (`CURSOR_AGENT` and/or `CURSOR_CONVERSATION_ID`)

render a Canvas board beside chat:

```bash
node <skill-dir>/scripts/hosts/cursor-capabilities.mjs

node <skill-dir>/scripts/hosts/cursor-canvas.mjs \
  <qa-board.json> \
  --out <canvases-dir>/qa-kanban-<run-id>.canvas.tsx \
  --report <report.json>
```

Details: [cursor-host.md](cursor-host.md).

Rules:

- Embed the validated board snapshot in the `.canvas.tsx` file (no `fetch`).
- Import only from `cursor/canvas`.
- Keep column scroll vertical-only and board scroll horizontal-only.
- Show card details in a full-width panel below the board (avoid absolute
  modals that clip inside Canvas side panels); never fake move/fix/verify.
- Refuse output paths that would overwrite the canonical input board JSON.
- If the gate fails, print or write Markdown and report `markdown-fallback`.
- Do not call Cursor Canvas a “Codex inline visualization”.

## Claude or another Artifact host

Render `--mode standalone`. Attach or display the CSP-protected HTML using the
host's supported artifact/file mechanism.

The embedded meta CSP blocks network, object, frame, base, and form actions.
If the artifact is hosted on HTTP, set `frame-ancestors 'none'` as an HTTP CSP
response header; browsers ignore that directive in a meta CSP.

Do not assume a Codex callback exists. Card selection and detail display may be
interactive, but state-changing actions stay hidden unless a verified host
bridge can persist the canonical JSON.

## Markdown fallback

Render Markdown when HTML/Canvas cannot be displayed. Include:

- board mode and lane
- counts by status and resolution
- cards grouped by status
- evidence summary and next action
- human learning references

Markdown is a full fallback, not an error message.

## No fake interaction

- Do not render drag-and-drop.
- Do not show a move, retry, fix, or verify button without a working handler.
- Do not visually move a card without updating and validating JSON first.
- Local card selection is allowed because it changes presentation only.
