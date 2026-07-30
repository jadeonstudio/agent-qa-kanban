# Human QA learning

Human QA learning is not background model training. It is an append-only,
auditable library of how users and staff judge product quality.

## Provenance boundary

| Source | Board | Human learning log |
| --- | --- | --- |
| direct user/staff report | yes | eligible |
| user correction of agent conclusion | yes | eligible |
| user approval of a generalized QA rule | yes | eligible |
| agent exploratory discovery | yes | no |
| automated test failure | yes | no |
| inferred product preference | yes, as candidate | no until human validation |

Every learning entry must use `source: "human-feedback"`.

Eligibility is not write authorization. Append only when repository policy
requires/allows it or the user explicitly authorizes the learning-log write.

## Required semantic fields

- `human_observed_symptom`
- `why_human_considered_it_wrong`
- `root_cause_or_decision`
- `expected_behavior`
- `future_autoqa_rule.trigger`
- `future_autoqa_rule.checks`
- `future_autoqa_rule.expected_evidence`
- `pattern_ids`
- `evidence_refs`
- `privacy.redacted`

Keep human judgment separate from the agent's diagnosis. The same symptom can
have an uncertain cause while still representing a valid human quality rule.

## Promotion

Use these statuses:

- `candidate`: captured from explicit human feedback but not yet generalized
- `approved`: accepted as a reusable future AutoQA rule
- `resolved`: the reported case was fixed and the rule remains active
- `superseded`: a newer append-only entry replaces the old decision

Agent observations never self-promote into this log. A human must confirm the
observation, explain why it is wrong, or approve the generalized rule.

## Append-only updates

Never edit or delete an old JSONL line to revise history. Append a new entry
with:

- a new ID
- `status: "superseded"` when appropriate
- `supersedes: ["OLD-ID"]`
- the updated rule or decision

The bundled recorder serializes local append operations with an adjacent
`.lock` file, rejects duplicate IDs, and requires every `supersedes` reference
to point to an older existing entry. If a process crashes, inspect and remove a
stale lock only after confirming no recorder is running. A shared network
filesystem still requires its own reliable locking guarantees.

## Applying learning during QA

1. Search entries by route, endpoint, domain, visible surface, and pattern ID.
2. Convert matching future rules into concrete board cards or checks.
3. Link learning IDs through `card.learning_refs`.
4. Prefer the human concern when prioritizing checks.
5. Continue adjacent exploration; the log is a starting perspective, not a
   closed test list.

## Privacy

Replace names, emails, phone numbers, tenant IDs, tokens, cookies, and private
payloads with safe descriptors before recording. Do not retain temporary local
screenshot paths that another user cannot access.
