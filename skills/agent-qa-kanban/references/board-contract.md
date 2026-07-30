# Board contract

## Source of truth

`qa-board.json` is canonical. HTML and Markdown are disposable renderings.
Update JSON first, validate it, then render a new snapshot.

The JSON Schema defines the portable structural contract. The bundled
`validate-board.mjs` additionally enforces cross-field transitions, permission
scope, provenance links, public evidence references, timestamp order, and
other semantic invariants that plain JSON Schema cannot fully express.

## Board fields

| Field | Purpose |
| --- | --- |
| `schema_version` | Contract version; currently `1.0` |
| `board` | Run identity, mode, lane, timestamps, locale, and project |
| `cards` | Ordered QA scenarios, findings, test debt, and improvements |

Summary counts are always derived from cards. Do not store hand-maintained
totals.

## Card field groups

| Group | Purpose |
| --- | --- |
| identity | `id`, `kind`, `title`, `summary` |
| flow state | `status`, `resolution`, `classification`, `severity`, `change_scope` |
| provenance | `origin`, `learning_refs` |
| location | `surface` with routes, endpoints, files, or UI paths |
| behavior | `reproduction`, expected and actual outcomes |
| diagnosis | confirmed or suspected cause with confidence |
| proof | `verification.checks` and `evidence` |
| continuation | `next_action`, blocker, related cards |
| audit trail | append-only `history` |

## Status and resolution are different

`status` controls the visible lane:

| Status | Meaning |
| --- | --- |
| `queued` | planned and not yet investigated |
| `investigating` | actively reproducing, tracing, or classifying |
| `fixing` | approved implementation or test change is underway |
| `verifying` | the original scenario is being rerun |
| `done` | resolved, accepted baseline, or cancelled duplicate with evidence |
| `blocked` | cannot safely continue or intentionally deferred |

`resolution` describes the outcome:

| Resolution | Meaning |
| --- | --- |
| `open` | work remains |
| `resolved` | behavior is fixed or check passed |
| `unresolved` | confirmed gap remains |
| `blocked` | proof/action requires missing authority or environment |
| `baseline` | pre-existing debt separated from the current change |
| `deferred` | intentionally postponed with a concrete next action |
| `cancelled` | duplicate, invalid, or explicitly removed from scope |

## Classification

- `confirmed-bug`
- `bug-candidate`
- `policy-unclear`
- `known-baseline`
- `environment-blocker`
- `test-debt`
- `passed-check`

Do not promote `bug-candidate` to `confirmed-bug` without reproducible evidence
or an authoritative contract.

## Change scope

- `none`: no test or product implementation is authorized for the card
- `tests-only`: focused test files may be implemented
- `approved-product`: product/test implementation was explicitly approved

Keep this field after moving a fixed card to `verifying` or `done`; it records
the scope used by its fixing history. A `write-tests` board rejects
`approved-product`, and every card that enters `fixing` must declare a non-none
scope.

## Transition invariants

Allowed normal transitions:

```text
queued -> investigating
investigating -> fixing | verifying | done | blocked
fixing -> verifying | blocked
verifying -> done | fixing | investigating | blocked
blocked -> investigating
done -> investigating
```

Additional rules:

- Moving from `done` reopens the card and requires a history reason.
- `done + resolved` requires a passing check and evidence.
- `done + baseline` requires baseline evidence.
- `done + cancelled` requires a cancellation reason in `next_action` or history.
- `blocked` requires `blocker.kind`, `blocker.required_action`, and
  `blocker.owner`.
- `fixing` requires board mode `fix-with-approval`, or `write-tests` when only
  focused test files are being implemented.
- `write-tests + fixing` requires `change_scope: "tests-only"`.
- Every non-queued card requires history, the first event starts from `queued`,
  and history is append-only and ordered by timestamp.
- Every classification except `passed-check` requires structured reproduction
  with steps, expected behavior, and actual behavior.

## Evidence

Evidence records contain a short safe summary and optional reference. Prefer:

- browser observation
- API response shape or status
- test command and result
- static contract trace
- screenshot reference
- log excerpt summary
- user or staff feedback reference

Do not store raw cookies, tokens, credentials, private payloads, or unredacted
personal data.

## Stable IDs

Use IDs that remain stable for the run:

```text
QA-FLOW-001
QA-FE-001
QA-BE-001
QA-FULL-001
QA-TOOL-001
QA-DEBT-001
```

Do not renumber existing cards after insertion.
