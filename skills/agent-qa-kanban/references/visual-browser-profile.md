# Visual/browser execution profile

The visual/browser profile is an optional execution axis. It is never selected
by default and does not replace the board mode or QA lane.

Valid combinations include:

```text
audit-only + dual-lane + visual-browser
write-tests + regression + visual-browser
fix-with-approval + exploration + visual-browser
```

## Activation gate

Add `board.execution_profile` only when the current user explicitly requests
visual or browser-interaction QA. A generic AutoQA, code review, API audit, or
kanban-rendering request does not activate it. Do not infer activation from a
legacy `check.type: "browser"`, a screenshot in an issue, or a host renderer.

Visual boards use `schema_version: "1.1"`. Existing `1.0` boards remain valid
and are treated as having no execution profile.

```json
{
  "schema_version": "1.1",
  "board": {
    "mode": "audit-only",
    "lane": "dual-lane",
    "execution_profile": {
      "name": "visual-browser",
      "activation": "explicit-user-request",
      "requested_at": "2026-08-07T01:00:00Z",
      "navigation_policy": "ui-interactions-after-entry",
      "server_policy": "observe-only",
      "browser_capability": {
        "status": "unverified",
        "host": "current-host",
        "checked_at": "2026-08-07T01:01:00Z",
        "probe_method": "runtime-not-verifiable",
        "summary": "The current runtime cannot verify a browser interaction tool."
      }
    }
  }
}
```

The constants make the authorization and safety boundary auditable:

- `activation` must be `explicit-user-request`.
- `navigation_policy` must be `ui-interactions-after-entry`: open the agreed
  initial entry point once, then use the product's menus, links, buttons, tabs,
  modals, and forms. Do not deep-link past steps.
- `server_policy` must be `observe-only`: never start, stop, or restart a
  user-owned server or browser process.

## Browser capability

Probe the tools exposed in the current runtime before executing a browser
check. Record one honest state:

| Status | Allowed probe method | Meaning |
| --- | --- | --- |
| `available` | `runtime-tool-inventory` or `successful-browser-round-trip` | A real browser interaction tool is callable now |
| `unavailable` | `runtime-tool-unavailable` | The runtime was checked and exposes no usable browser interaction tool |
| `unverified` | `runtime-not-verifiable` | The current host/tool inventory cannot establish capability |

A Canvas, HTML renderer, Markdown file, browser manifest, installed skill, or
host name is not browser-execution evidence. Codex, Cursor, Claude, Grok, and
other hosts are supported only when their current runtime exposes and verifies
an actual interaction tool.

When capability is `unavailable` or `unverified`, every card containing a
browser check must be:

- `status: "blocked"`
- `resolution: "blocked"`
- `classification: "environment-blocker"`
- equipped with an environment blocker and a concrete required action
- equipped with browser checks whose status is `blocked`

Do not add browser observations or screenshot evidence in that state.

## Scenario and finding mapping

Create `flow` cards before execution for known screen scenarios. Add `finding`
cards immediately when a defect is observed. Both use the existing canonical
fields:

| Visual QA concept | Canonical board field |
| --- | --- |
| screen/flow scenario | `kind: "flow"` card |
| visual or interaction defect | `kind: "finding"` card |
| preconditions and interaction steps | `reproduction.preconditions` / `steps` |
| expected and actual behavior | `reproduction.expected` / `actual` |
| validation/loading/empty/error/navigation checks | `verification.checks` with `type: "browser"` |
| severity | `severity` |
| screenshot or observation | `evidence` plus check `evidence_refs` |
| final counts and summary | derived renderers and `visual/summary.md` |

A resolved visual card requires a passing browser check and linked
`browser-observation` or `screenshot-ref` evidence. A screenshot reference must
be under `visual/screenshots/`; other relative visual evidence stays under
`visual/`.

## Derived artifact layout

`qa-board.json` remains the only QA source of truth:

```text
.qa-kanban/runs/<run-id>/
  qa-board.json                 # canonical
  visual/
    screenshots/               # redacted evidence files
    evidence/                  # redacted logs/DOM notes
    summary.md                 # derived from qa-board.json
```

After the profile and scenario cards are in a validated run board:

```bash
node <skill-dir>/scripts/visual-artifacts.mjs \
  .qa-kanban/runs/<run-id>/qa-board.json
```

The helper refuses non-visual and `plan-only` boards, traversal, absolute
output paths, symlink directories, hardlinked outputs, and any target that
aliases canonical JSON. It never mutates the board, product source, or server
state. When capability is not `available`, it permits the derived blocked
summary but refuses browser evidence writes.

Store only run-relative refs such as
`visual/screenshots/checkout-step-03.png`. Never put an absolute path, home
directory, credential, cookie, token, account identifier, email, phone number,
or unredacted screenshot into the board or derived summary.

## Migration from `qa-visual-tester`

Do not copy the legacy `QA/run-*` directory or Python helpers into a new run.
Map its scenarios and issues to cards, copy only reviewed/redacted evidence
into the run-local `visual/` directory, and validate the board. Do not parse a
legacy Markdown status table back into canonical state.

The separate skill can be removed only after:

1. every active workflow invokes this explicit profile instead of `QA/run-*`
2. any evidence that must be retained is redacted and linked from board cards
3. the new workflow has completed a real browser-capable round trip in each
   host the team claims to support
4. no automation or documentation still depends on the Python helpers
