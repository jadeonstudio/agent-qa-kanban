import {
  CARD_STATUSES,
  summarizeBoard,
} from "./board-lib.mjs";

// 카드 상태, 증거, 다음 행동을 HTML 보드와 같은 원본에서 파생한다.
export function renderMarkdownBoard(board) {
  const summary = summarizeBoard(board);
  const lines = [
    `# ${escapeMarkdown(board.board.title)}`,
    "",
    `- Project: ${escapeMarkdown(board.board.project.name)}`,
    `- Run: ${escapeMarkdown(board.board.run_id)}`,
    `- Mode: ${escapeMarkdown(board.board.mode)}`,
    `- QA lane: ${escapeMarkdown(board.board.lane)}`,
    `- Updated: ${escapeMarkdown(board.board.updated_at)}`,
    `- Total: ${summary.total}; active: ${summary.active}; done: ${summary.done}; blocked: ${summary.blocked}`,
    "",
    "## Resolution summary",
    "",
    "| Resolution | Count |",
    "| --- | ---: |",
    ...Object.entries(summary.byResolution).map(
      ([resolution, count]) => `| ${escapeMarkdown(resolution)} | ${count} |`,
    ),
  ];

  for (const status of CARD_STATUSES) {
    const cards = board.cards.filter((card) => card.status === status);
    lines.push("", `## ${escapeMarkdown(status)} (${cards.length})`, "");
    if (cards.length === 0) {
      lines.push("_No cards._");
      continue;
    }
    for (const card of cards) {
      lines.push(
        `### ${escapeMarkdown(card.id)} · ${escapeMarkdown(card.title)}`,
        "",
        `- Classification: ${escapeMarkdown(card.classification)}`,
        `- Resolution: ${escapeMarkdown(card.resolution)}`,
        `- Severity: ${escapeMarkdown(card.severity)}`,
        `- Change scope: ${escapeMarkdown(card.change_scope)}`,
        `- Surface: ${escapeMarkdown(card.surface.area)} — ${escapeMarkdown(card.surface.location)}`,
        `- Summary: ${escapeMarkdown(card.summary)}`,
      );
      for (const [label, values] of [
        ["Routes", card.surface.routes ?? []],
        ["Endpoints", card.surface.endpoints ?? []],
        ["Files", card.surface.files ?? []],
      ]) {
        if (values.length > 0) {
          lines.push(
            `- ${label}: ${values.map(escapeMarkdown).join(", ")}`,
          );
        }
      }
      if (card.reproduction) {
        lines.push(
          `- Expected: ${escapeMarkdown(card.reproduction.expected)}`,
          `- Actual: ${escapeMarkdown(card.reproduction.actual)}`,
          "- Reproduction:",
          ...[
            ...(card.reproduction.preconditions ?? []).map(
              (value) => `precondition: ${value}`,
            ),
            ...card.reproduction.steps,
          ].map((value) => `  - ${escapeMarkdown(value)}`),
        );
      }
      if (card.diagnosis) {
        lines.push(
          `- Diagnosis: ${escapeMarkdown(card.diagnosis.confidence)} — ${escapeMarkdown(card.diagnosis.summary)}`,
        );
      }

      lines.push("- Verification checks:");
      for (const check of card.verification.checks) {
        lines.push(
          `  - ${escapeMarkdown(check.status)} · ${escapeMarkdown(check.type)}: ${escapeMarkdown(check.summary)}`,
        );
      }

      if (card.evidence.length > 0) {
        lines.push("- Evidence:");
        for (const evidence of card.evidence) {
          const reference = evidence.ref
            ? ` (${escapeMarkdown(evidence.ref)})`
            : "";
          lines.push(
            `  - ${escapeMarkdown(evidence.type)}: ${escapeMarkdown(evidence.summary)}${reference}`,
          );
        }
      } else {
        lines.push("- Evidence: none yet");
      }

      if (card.blocker) {
        lines.push(
          `- Blocker: ${escapeMarkdown(card.blocker.kind)} — ${escapeMarkdown(card.blocker.required_action)} — owner: ${escapeMarkdown(card.blocker.owner)}`,
        );
      }
      lines.push(
        `- Next action: ${escapeMarkdown(card.next_action)}`,
        `- Human learning: ${
          card.learning_refs.length > 0
            ? card.learning_refs.map(escapeMarkdown).join(", ")
            : "none"
        }`,
        "- History:",
        ...card.history.map(
          (event) =>
            `  - ${escapeMarkdown(event.at)} · ${escapeMarkdown(event.from)} → ${escapeMarkdown(event.to)} · ${escapeMarkdown(event.reason)}`,
        ),
        "",
      );
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

// Markdown/HTML 해석을 피하면서 한 줄 정보 구조를 유지한다.
export function escapeMarkdown(value) {
  return String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("|", "\\|")
    .replaceAll("\r", " ")
    .replaceAll("\n", " ")
    .replace(/([`*_{}[\]()#+.!-])/g, "\\$1");
}
