import { readFile } from "node:fs/promises";

// 보드와 학습 로그에서 허용하지 않는 프로토타입 오염 키다.
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export const BOARD_MODES = [
  "audit-only",
  "write-tests",
  "fix-with-approval",
  "plan-only",
];
export const BOARD_SCHEMA_VERSIONS = ["1.0", "1.1"];
export const QA_LANES = ["regression", "exploration", "dual-lane"];
export const EXECUTION_PROFILES = ["visual-browser"];
export const BROWSER_CAPABILITY_STATUSES = [
  "available",
  "unavailable",
  "unverified",
];
export const BROWSER_PROBE_METHODS = [
  "runtime-tool-inventory",
  "successful-browser-round-trip",
  "runtime-tool-unavailable",
  "runtime-not-verifiable",
];
export const CARD_STATUSES = [
  "queued",
  "investigating",
  "fixing",
  "verifying",
  "done",
  "blocked",
];
export const CARD_RESOLUTIONS = [
  "open",
  "resolved",
  "unresolved",
  "blocked",
  "baseline",
  "deferred",
  "cancelled",
];
export const CARD_CLASSIFICATIONS = [
  "confirmed-bug",
  "bug-candidate",
  "policy-unclear",
  "known-baseline",
  "environment-blocker",
  "test-debt",
  "passed-check",
];
export const CHANGE_SCOPES = ["none", "tests-only", "approved-product"];

// 카드 이력에서 허용하는 상태 전이만 명시해 시각화와 원본 상태의 불일치를 막는다.
const ALLOWED_TRANSITIONS = new Map([
  ["queued", new Set(["investigating"])],
  ["investigating", new Set(["fixing", "verifying", "done", "blocked"])],
  ["fixing", new Set(["verifying", "blocked"])],
  ["verifying", new Set(["done", "fixing", "investigating", "blocked"])],
  ["blocked", new Set(["investigating"])],
  ["done", new Set(["investigating"])],
]);

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const LOCALE_PATTERN = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export class ValidationError extends Error {
  // 여러 계약 위반을 한 번에 보여줘 수정 반복 횟수를 줄인다.
  constructor(label, errors) {
    super(`${label} validation failed:\n- ${errors.join("\n- ")}`);
    this.name = "ValidationError";
    this.errors = errors;
  }
}

// 외부에서 들어온 JSON을 파싱한 뒤 위험 키를 재귀적으로 거부한다.
export function parseUntrustedJson(text, label = "JSON") {
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new ValidationError(label, [`invalid JSON: ${error.message}`]);
  }

  const integrityErrors = collectDuplicateJsonKeyErrors(text);
  collectDangerousKeyErrors(value, "$", integrityErrors);
  if (integrityErrors.length > 0) {
    throw new ValidationError(label, integrityErrors);
  }
  return value;
}

// 파일을 UTF-8로 읽고 동일한 안전 파서로 검증한다.
export async function readSafeJson(filePath, label = filePath) {
  const text = await readFile(filePath, "utf8");
  return parseUntrustedJson(text, label);
}

// 렌더러가 호출하기 전에 보드의 구조와 상태 불변식을 모두 확인한다.
export function assertValidBoard(board) {
  const errors = collectBoardErrors(board);
  if (errors.length > 0) {
    throw new ValidationError("QA board", errors);
  }
  return board;
}

// JSON Schema의 공개 계약과 실행 시 필요한 상태 불변식을 함께 검사한다.
export function collectBoardErrors(board) {
  const errors = [];
  collectDangerousKeyErrors(board, "$", errors);
  if (!isRecord(board)) {
    return ["$ must be an object"];
  }

  validateExactObject(
    board,
    "$",
    ["schema_version", "board", "cards"],
    ["schema_version", "board", "cards"],
    errors,
  );
  validateEnum(
    board.schema_version,
    BOARD_SCHEMA_VERSIONS,
    "$.schema_version",
    errors,
  );
  validateBoardMetadata(board.board, "$.board", board.schema_version, errors);

  if (!Array.isArray(board.cards)) {
    errors.push("$.cards must be an array");
    return errors;
  }

  const cardIds = new Set();
  for (const [index, card] of board.cards.entries()) {
    const cardPath = `$.cards[${index}]`;
    validateCard(card, cardPath, board.board, errors);
    if (isRecord(card) && typeof card.id === "string") {
      if (cardIds.has(card.id)) {
        errors.push(`${cardPath}.id duplicates card ID ${card.id}`);
      }
      cardIds.add(card.id);
    }
  }

  for (const [index, card] of board.cards.entries()) {
    if (!isRecord(card) || !Array.isArray(card.related_cards)) {
      continue;
    }
    for (const relatedId of card.related_cards) {
      if (relatedId === card.id) {
        errors.push(`$.cards[${index}].related_cards cannot reference itself`);
      } else if (!cardIds.has(relatedId)) {
        errors.push(
          `$.cards[${index}].related_cards references missing card ${relatedId}`,
        );
      }
    }
  }

  validateExecutionProfileInvariants(board, errors);

  return errors;
}

// 인간 QA 학습 항목이 명시적 인간 피드백이며 비식별화됐는지 검증한다.
export function assertValidHumanLearningEntry(entry) {
  const errors = collectHumanLearningErrors(entry);
  if (errors.length > 0) {
    throw new ValidationError("Human QA learning entry", errors);
  }
  return entry;
}

// append-only 학습 로그의 공개 스키마와 provenance 규칙을 검사한다.
export function collectHumanLearningErrors(entry) {
  const errors = [];
  collectDangerousKeyErrors(entry, "$", errors);
  if (!isRecord(entry)) {
    return ["$ must be an object"];
  }

  const requiredKeys = [
    "id",
    "recorded_at",
    "source",
    "status",
    "session_id",
    "surface",
    "human_observed_symptom",
    "why_human_considered_it_wrong",
    "root_cause_or_decision",
    "expected_behavior",
    "future_autoqa_rule",
    "pattern_ids",
    "evidence_refs",
    "related_card_ids",
    "privacy",
  ];
  validateExactObject(
    entry,
    "$",
    requiredKeys,
    [...requiredKeys, "supersedes"],
    errors,
  );
  validateId(entry.id, "$.id", errors);
  validateTimestamp(entry.recorded_at, "$.recorded_at", errors);
  validateConst(entry.source, "human-feedback", "$.source", errors);
  validateEnum(
    entry.status,
    ["candidate", "approved", "resolved", "superseded"],
    "$.status",
    errors,
  );
  validateString(entry.session_id, "$.session_id", errors, {
    min: 1,
    max: 200,
  });
  validateSurface(entry.surface, "$.surface", errors, true);

  for (const key of [
    "human_observed_symptom",
    "why_human_considered_it_wrong",
    "root_cause_or_decision",
    "expected_behavior",
  ]) {
    validateString(entry[key], `$.${key}`, errors, { min: 1, max: 4000 });
  }

  validateFutureRule(entry.future_autoqa_rule, "$.future_autoqa_rule", errors);
  validateStringArray(entry.pattern_ids, "$.pattern_ids", errors, {
    maxString: 200,
    minItems: 1,
    unique: true,
  });
  validateStringArray(entry.evidence_refs, "$.evidence_refs", errors, {
    maxString: 1000,
    unique: true,
  });
  validateStringArray(entry.related_card_ids, "$.related_card_ids", errors, {
    maxString: 100,
    unique: true,
  });

  if (entry.supersedes !== undefined) {
    validateStringArray(entry.supersedes, "$.supersedes", errors, {
      maxString: 100,
      minItems: 1,
      unique: true,
    });
  }
  if (
    entry.status === "superseded" &&
    (!Array.isArray(entry.supersedes) || entry.supersedes.length === 0)
  ) {
    errors.push("$.supersedes must identify an older entry when status is superseded");
  }
  if (Array.isArray(entry.supersedes) && entry.supersedes.includes(entry.id)) {
    errors.push("$.supersedes must not reference the entry itself");
  }

  validatePrivacy(entry.privacy, "$.privacy", errors);
  return errors;
}

// 상태별·결과별 숫자는 JSON에 중복 저장하지 않고 카드에서 항상 계산한다.
export function summarizeBoard(board) {
  const byStatus = Object.fromEntries(CARD_STATUSES.map((status) => [status, 0]));
  const byResolution = Object.fromEntries(
    CARD_RESOLUTIONS.map((resolution) => [resolution, 0]),
  );
  const bySeverity = Object.fromEntries(
    ["critical", "high", "medium", "low", "info"].map((severity) => [
      severity,
      0,
    ]),
  );

  for (const card of board.cards) {
    byStatus[card.status] += 1;
    byResolution[card.resolution] += 1;
    bySeverity[card.severity] += 1;
  }

  return {
    total: board.cards.length,
    byStatus,
    byResolution,
    bySeverity,
    active:
      byStatus.queued +
      byStatus.investigating +
      byStatus.fixing +
      byStatus.verifying,
    done: byStatus.done,
    blocked: byStatus.blocked,
  };
}

// Visual/browser QA는 명시적 profile 필드가 있을 때만 활성화된 것으로 본다.
// 과거 1.0 보드의 browser check는 호환성을 위해 그대로 읽되 opt-in으로 승격하지 않는다.
export function isVisualBrowserProfile(boardDocument) {
  return boardDocument?.board?.execution_profile?.name === "visual-browser";
}

// JSON을 script 태그에 안전하게 넣도록 태그 종료와 특수 문자를 이스케이프한다.
export function serializeForHtmlScript(value) {
  return JSON.stringify(value)
    .replaceAll("&", "\\u0026")
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

// 호스트 follow-up에는 저장소 지침을 덮을 수 없는 최소 허용 필드만 전달한다.
export function buildFollowUpPayload(card) {
  return {
    id: card.id,
    title: card.title,
    status: card.status,
    acceptance_criteria: [...card.verification.acceptance_criteria],
    evidence: card.evidence.map((item) => item.summary),
    next_action: card.next_action,
  };
}

function validateBoardMetadata(board, path, schemaVersion, errors) {
  if (!isRecord(board)) {
    errors.push(`${path} must be an object`);
    return;
  }

  const requiredKeys = [
    "id",
    "title",
    "project",
    "run_id",
    "mode",
    "lane",
    "created_at",
    "updated_at",
    "locale",
    "sensitive_data_redacted",
  ];
  validateExactObject(
    board,
    path,
    requiredKeys,
    [...requiredKeys, "goal", "human_learning_log", "execution_profile"],
    errors,
  );
  validateId(board.id, `${path}.id`, errors);
  validateString(board.title, `${path}.title`, errors, { min: 1, max: 160 });
  validateProject(board.project, `${path}.project`, errors);
  validateId(board.run_id, `${path}.run_id`, errors);
  validateString(board.goal, `${path}.goal`, errors, {
    min: 0,
    max: 1000,
    optional: true,
  });
  validateEnum(board.mode, BOARD_MODES, `${path}.mode`, errors);
  validateEnum(board.lane, QA_LANES, `${path}.lane`, errors);
  if (board.execution_profile !== undefined) {
    if (schemaVersion !== "1.1") {
      errors.push(
        `${path}.execution_profile requires schema_version 1.1`,
      );
    }
    validateExecutionProfile(
      board.execution_profile,
      `${path}.execution_profile`,
      errors,
    );
  }
  validateTimestamp(board.created_at, `${path}.created_at`, errors);
  validateTimestamp(board.updated_at, `${path}.updated_at`, errors);
  if (
    isTimestamp(board.created_at) &&
    isTimestamp(board.updated_at) &&
    Date.parse(board.updated_at) < Date.parse(board.created_at)
  ) {
    errors.push(`${path}.updated_at must not precede created_at`);
  }
  validateString(board.locale, `${path}.locale`, errors, {
    min: 2,
    max: 35,
  });
  if (typeof board.locale === "string" && !LOCALE_PATTERN.test(board.locale)) {
    errors.push(`${path}.locale must be a BCP 47-style language tag`);
  }
  validateString(
    board.human_learning_log,
    `${path}.human_learning_log`,
    errors,
    { min: 0, max: 500, optional: true },
  );
  validateConst(
    board.sensitive_data_redacted,
    true,
    `${path}.sensitive_data_redacted`,
    errors,
  );
}

function validateExecutionProfile(profile, path, errors) {
  if (!isRecord(profile)) {
    errors.push(`${path} must be an object`);
    return;
  }
  const requiredKeys = [
    "name",
    "activation",
    "requested_at",
    "navigation_policy",
    "server_policy",
    "browser_capability",
  ];
  validateExactObject(profile, path, requiredKeys, requiredKeys, errors);
  validateEnum(profile.name, EXECUTION_PROFILES, `${path}.name`, errors);
  validateConst(
    profile.activation,
    "explicit-user-request",
    `${path}.activation`,
    errors,
  );
  validateTimestamp(profile.requested_at, `${path}.requested_at`, errors);
  validateConst(
    profile.navigation_policy,
    "ui-interactions-after-entry",
    `${path}.navigation_policy`,
    errors,
  );
  validateConst(
    profile.server_policy,
    "observe-only",
    `${path}.server_policy`,
    errors,
  );
  validateBrowserCapability(
    profile.browser_capability,
    `${path}.browser_capability`,
    errors,
  );
}

function validateBrowserCapability(capability, path, errors) {
  if (!isRecord(capability)) {
    errors.push(`${path} must be an object`);
    return;
  }
  const requiredKeys = [
    "status",
    "host",
    "checked_at",
    "probe_method",
    "summary",
  ];
  validateExactObject(capability, path, requiredKeys, requiredKeys, errors);
  validateEnum(
    capability.status,
    BROWSER_CAPABILITY_STATUSES,
    `${path}.status`,
    errors,
  );
  validateString(capability.host, `${path}.host`, errors, {
    min: 1,
    max: 120,
  });
  validateTimestamp(capability.checked_at, `${path}.checked_at`, errors);
  validateEnum(
    capability.probe_method,
    BROWSER_PROBE_METHODS,
    `${path}.probe_method`,
    errors,
  );
  validateString(capability.summary, `${path}.summary`, errors, {
    min: 1,
    max: 1000,
  });

  const validMethods = {
    available: new Set([
      "runtime-tool-inventory",
      "successful-browser-round-trip",
    ]),
    unavailable: new Set(["runtime-tool-unavailable"]),
    unverified: new Set(["runtime-not-verifiable"]),
  };
  if (
    typeof capability.status === "string" &&
    typeof capability.probe_method === "string" &&
    validMethods[capability.status] &&
    !validMethods[capability.status].has(capability.probe_method)
  ) {
    errors.push(
      `${path}.probe_method cannot support status ${capability.status}`,
    );
  }
}

function validateProject(project, path, errors) {
  if (!isRecord(project)) {
    errors.push(`${path} must be an object`);
    return;
  }
  validateExactObject(project, path, ["name"], ["name", "repository"], errors);
  validateString(project.name, `${path}.name`, errors, { min: 1, max: 120 });
  validateString(project.repository, `${path}.repository`, errors, {
    min: 0,
    max: 300,
    optional: true,
  });
}

function validateCard(card, path, board, errors) {
  if (!isRecord(card)) {
    errors.push(`${path} must be an object`);
    return;
  }

  const requiredKeys = [
    "id",
    "kind",
    "title",
    "summary",
    "status",
    "resolution",
    "classification",
    "severity",
    "change_scope",
    "origin",
    "surface",
    "verification",
    "evidence",
    "next_action",
    "learning_refs",
    "related_cards",
    "history",
    "updated_at",
  ];
  validateExactObject(
    card,
    path,
    requiredKeys,
    [...requiredKeys, "reproduction", "diagnosis", "blocker"],
    errors,
  );
  validateId(card.id, `${path}.id`, errors);
  validateEnum(
    card.kind,
    ["flow", "finding", "test-debt", "improvement"],
    `${path}.kind`,
    errors,
  );
  validateString(card.title, `${path}.title`, errors, { min: 1, max: 180 });
  validateString(card.summary, `${path}.summary`, errors, {
    min: 1,
    max: 4000,
  });
  validateEnum(card.status, CARD_STATUSES, `${path}.status`, errors);
  validateEnum(card.resolution, CARD_RESOLUTIONS, `${path}.resolution`, errors);
  validateEnum(
    card.classification,
    CARD_CLASSIFICATIONS,
    `${path}.classification`,
    errors,
  );
  validateEnum(
    card.severity,
    ["critical", "high", "medium", "low", "info"],
    `${path}.severity`,
    errors,
  );
  validateEnum(
    card.change_scope,
    CHANGE_SCOPES,
    `${path}.change_scope`,
    errors,
  );
  validateOrigin(card.origin, `${path}.origin`, errors);
  validateSurface(card.surface, `${path}.surface`, errors, false);
  if (card.reproduction !== undefined) {
    validateReproduction(card.reproduction, `${path}.reproduction`, errors);
  }
  if (card.diagnosis !== undefined) {
    validateDiagnosis(card.diagnosis, `${path}.diagnosis`, errors);
  }
  validateVerification(card.verification, `${path}.verification`, errors);
  validateEvidence(card.evidence, `${path}.evidence`, errors);
  validateString(card.next_action, `${path}.next_action`, errors, {
    min: 1,
    max: 4000,
  });
  if (card.blocker !== undefined) {
    validateBlocker(card.blocker, `${path}.blocker`, errors);
  }
  validateStringArray(card.learning_refs, `${path}.learning_refs`, errors, {
    maxString: 200,
    unique: true,
  });
  validateStringArray(card.related_cards, `${path}.related_cards`, errors, {
    maxString: 100,
    unique: true,
  });
  validateHistory(card.history, `${path}.history`, card, board, errors);
  validateTimestamp(card.updated_at, `${path}.updated_at`, errors);

  if (
    isRecord(board) &&
    isTimestamp(board.updated_at) &&
    isTimestamp(card.updated_at) &&
    Date.parse(card.updated_at) > Date.parse(board.updated_at)
  ) {
    errors.push(`${path}.updated_at must not be newer than board.updated_at`);
  }

  validateCardInvariants(card, path, board, errors);
}

function validateOrigin(origin, path, errors) {
  if (!isRecord(origin)) {
    errors.push(`${path} must be an object`);
    return;
  }
  validateExactObject(
    origin,
    path,
    ["type"],
    ["type", "source_ref", "reported_at"],
    errors,
  );
  validateEnum(
    origin.type,
    [
      "human-feedback",
      "agent-observation",
      "requirement",
      "code-change",
      "automated-check",
    ],
    `${path}.type`,
    errors,
  );
  validateString(origin.source_ref, `${path}.source_ref`, errors, {
    min: 1,
    max: 500,
    optional: true,
  });
  if (origin.reported_at !== undefined) {
    validateTimestamp(origin.reported_at, `${path}.reported_at`, errors);
  }
}

function validateSurface(surface, path, errors, humanEntry) {
  if (!isRecord(surface)) {
    errors.push(`${path} must be an object`);
    return;
  }
  const optionalKeys = humanEntry
    ? ["area", "location"]
    : ["area", "location", "routes", "endpoints", "files"];
  validateExactObject(
    surface,
    path,
    ["area", "location"],
    optionalKeys,
    errors,
  );
  validateString(surface.area, `${path}.area`, errors, { min: 1, max: 120 });
  validateString(surface.location, `${path}.location`, errors, {
    min: 1,
    max: 500,
  });
  if (!humanEntry) {
    for (const key of ["routes", "endpoints", "files"]) {
      if (surface[key] !== undefined) {
        validateStringArray(surface[key], `${path}.${key}`, errors, {
          maxString: 500,
          unique: true,
        });
      }
    }
  }
}

function validateReproduction(reproduction, path, errors) {
  if (!isRecord(reproduction)) {
    errors.push(`${path} must be an object`);
    return;
  }
  validateExactObject(
    reproduction,
    path,
    ["steps", "expected", "actual"],
    ["preconditions", "steps", "expected", "actual"],
    errors,
  );
  if (reproduction.preconditions !== undefined) {
    validateStringArray(
      reproduction.preconditions,
      `${path}.preconditions`,
      errors,
      { maxString: 4000 },
    );
  }
  validateStringArray(reproduction.steps, `${path}.steps`, errors, {
    minItems: 1,
    maxString: 4000,
  });
  validateString(reproduction.expected, `${path}.expected`, errors, {
    min: 1,
    max: 4000,
  });
  validateString(reproduction.actual, `${path}.actual`, errors, {
    min: 1,
    max: 4000,
  });
}

function validateDiagnosis(diagnosis, path, errors) {
  if (!isRecord(diagnosis)) {
    errors.push(`${path} must be an object`);
    return;
  }
  validateExactObject(
    diagnosis,
    path,
    ["summary", "confidence"],
    ["summary", "confidence"],
    errors,
  );
  validateString(diagnosis.summary, `${path}.summary`, errors, {
    min: 1,
    max: 4000,
  });
  validateEnum(
    diagnosis.confidence,
    ["unknown", "candidate", "probable", "confirmed"],
    `${path}.confidence`,
    errors,
  );
}

function validateVerification(verification, path, errors) {
  if (!isRecord(verification)) {
    errors.push(`${path} must be an object`);
    return;
  }
  validateExactObject(
    verification,
    path,
    ["acceptance_criteria", "checks"],
    ["acceptance_criteria", "checks"],
    errors,
  );
  validateStringArray(
    verification.acceptance_criteria,
    `${path}.acceptance_criteria`,
    errors,
    { minItems: 1, maxString: 4000 },
  );
  if (!Array.isArray(verification.checks)) {
    errors.push(`${path}.checks must be an array`);
    return;
  }
  if (verification.checks.length === 0) {
    errors.push(`${path}.checks must contain at least 1 item`);
  }

  const checkIds = new Set();
  for (const [index, check] of verification.checks.entries()) {
    const checkPath = `${path}.checks[${index}]`;
    validateCheck(check, checkPath, errors);
    if (isRecord(check) && typeof check.id === "string") {
      if (checkIds.has(check.id)) {
        errors.push(`${checkPath}.id duplicates check ID ${check.id}`);
      }
      checkIds.add(check.id);
    }
  }
}

function validateCheck(check, path, errors) {
  if (!isRecord(check)) {
    errors.push(`${path} must be an object`);
    return;
  }
  validateExactObject(
    check,
    path,
    ["id", "type", "status", "summary"],
    ["id", "type", "status", "summary", "evidence_refs"],
    errors,
  );
  validateId(check.id, `${path}.id`, errors);
  validateEnum(
    check.type,
    ["static", "unit", "integration", "api", "browser", "manual", "other"],
    `${path}.type`,
    errors,
  );
  validateEnum(
    check.status,
    ["planned", "passed", "failed", "blocked", "skipped"],
    `${path}.status`,
    errors,
  );
  validateString(check.summary, `${path}.summary`, errors, {
    min: 1,
    max: 4000,
  });
  if (check.evidence_refs !== undefined) {
    validateStringArray(check.evidence_refs, `${path}.evidence_refs`, errors, {
      maxString: 200,
      unique: true,
    });
  }
}

function validateEvidence(evidence, path, errors) {
  if (!Array.isArray(evidence)) {
    errors.push(`${path} must be an array`);
    return;
  }
  const evidenceIds = new Set();
  for (const [index, item] of evidence.entries()) {
    const itemPath = `${path}[${index}]`;
    if (!isRecord(item)) {
      errors.push(`${itemPath} must be an object`);
      continue;
    }
    validateExactObject(
      item,
      itemPath,
      ["id", "type", "summary", "captured_at", "redacted"],
      ["id", "type", "summary", "ref", "captured_at", "redacted"],
      errors,
    );
    validateId(item.id, `${itemPath}.id`, errors);
    validateEnum(
      item.type,
      [
        "browser-observation",
        "api-observation",
        "test-result",
        "static-trace",
        "screenshot-ref",
        "log-summary",
        "human-feedback-ref",
        "other",
      ],
      `${itemPath}.type`,
      errors,
    );
    validateString(item.summary, `${itemPath}.summary`, errors, {
      min: 1,
      max: 4000,
    });
    validateEvidenceReference(item.ref, `${itemPath}.ref`, errors);
    validateTimestamp(item.captured_at, `${itemPath}.captured_at`, errors);
    validateConst(item.redacted, true, `${itemPath}.redacted`, errors);

    if (typeof item.id === "string") {
      if (evidenceIds.has(item.id)) {
        errors.push(`${itemPath}.id duplicates evidence ID ${item.id}`);
      }
      evidenceIds.add(item.id);
    }
  }
}

function validateBlocker(blocker, path, errors) {
  if (!isRecord(blocker)) {
    errors.push(`${path} must be an object`);
    return;
  }
  validateExactObject(
    blocker,
    path,
    ["kind", "required_action", "owner"],
    ["kind", "required_action", "owner"],
    errors,
  );
  validateEnum(
    blocker.kind,
    ["authority", "environment", "policy", "credential", "dependency", "other"],
    `${path}.kind`,
    errors,
  );
  validateString(blocker.required_action, `${path}.required_action`, errors, {
    min: 1,
    max: 4000,
  });
  validateString(blocker.owner, `${path}.owner`, errors, { min: 1, max: 120 });
}

function validateHistory(history, path, card, board, errors) {
  if (!Array.isArray(history)) {
    errors.push(`${path} must be an array`);
    return;
  }
  if (history.length === 0 && card.status !== "queued") {
    errors.push(`${path} is required when card.status is not queued`);
    return;
  }
  if (history.length > 0 && history[0]?.from !== "queued") {
    errors.push(`${path}[0].from must start from queued`);
  }

  let priorTimestamp = null;
  for (const [index, event] of history.entries()) {
    const eventPath = `${path}[${index}]`;
    if (!isRecord(event)) {
      errors.push(`${eventPath} must be an object`);
      continue;
    }
    validateExactObject(
      event,
      eventPath,
      ["at", "actor", "from", "to", "reason"],
      ["at", "actor", "from", "to", "reason"],
      errors,
    );
    validateTimestamp(event.at, `${eventPath}.at`, errors);
    validateString(event.actor, `${eventPath}.actor`, errors, {
      min: 1,
      max: 120,
    });
    validateEnum(event.from, CARD_STATUSES, `${eventPath}.from`, errors);
    validateEnum(event.to, CARD_STATUSES, `${eventPath}.to`, errors);
    validateString(event.reason, `${eventPath}.reason`, errors, {
      min: 1,
      max: 4000,
    });

    if (
      CARD_STATUSES.includes(event.from) &&
      CARD_STATUSES.includes(event.to) &&
      !ALLOWED_TRANSITIONS.get(event.from)?.has(event.to)
    ) {
      errors.push(
        `${eventPath} contains disallowed transition ${event.from} -> ${event.to}`,
      );
    }
    if (index > 0 && isRecord(history[index - 1])) {
      if (history[index - 1].to !== event.from) {
        errors.push(
          `${eventPath}.from must match the previous history event's to status`,
        );
      }
    }
    if (priorTimestamp !== null && isTimestamp(event.at)) {
      if (Date.parse(event.at) < priorTimestamp) {
        errors.push(`${eventPath}.at must not precede the previous event`);
      }
    }
    if (isTimestamp(event.at)) {
      priorTimestamp = Date.parse(event.at);
    }
    if (
      isRecord(board) &&
      !["fix-with-approval", "write-tests"].includes(board.mode) &&
      (event.from === "fixing" || event.to === "fixing")
    ) {
      errors.push(
        `${eventPath} uses fixing but board.mode does not authorize implementation`,
      );
    }
  }

  const lastEvent = history.at(-1);
  if (isRecord(lastEvent) && lastEvent.to !== card.status) {
    errors.push(`${path} last to status must equal card.status`);
  }
  if (
    isRecord(lastEvent) &&
    isTimestamp(lastEvent.at) &&
    isTimestamp(card.updated_at) &&
    Date.parse(lastEvent.at) > Date.parse(card.updated_at)
  ) {
    errors.push(`${path} last event must not be newer than card.updated_at`);
  }
}

function validateCardInvariants(card, path, board, errors) {
  const touchedFixing =
    card.status === "fixing" ||
    (Array.isArray(card.history) &&
      card.history.some(
        (event) => event?.from === "fixing" || event?.to === "fixing",
      ));
  if (
    ["audit-only", "plan-only"].includes(board?.mode) &&
    card.change_scope !== "none"
  ) {
    errors.push(
      `${path}.change_scope must be none when board.mode does not authorize implementation`,
    );
  }
  if (board?.mode === "write-tests" && card.change_scope === "approved-product") {
    errors.push(
      `${path}.change_scope cannot authorize product changes in write-tests mode`,
    );
  }
  if (touchedFixing && card.change_scope === "none") {
    errors.push(`${path}.change_scope must declare the authorized fixing scope`);
  }
  if (
    touchedFixing &&
    board?.mode === "write-tests" &&
    card.change_scope !== "tests-only"
  ) {
    errors.push(
      `${path}.change_scope must be tests-only for fixing in write-tests mode`,
    );
  }
  if (
    card.status === "fixing" &&
    !["fix-with-approval", "write-tests"].includes(board?.mode)
  ) {
    errors.push(`${path}.status cannot be fixing in the current board mode`);
  }
  if (card.classification !== "passed-check" && !isRecord(card.reproduction)) {
    errors.push(
      `${path}.reproduction is required for every non-passing card`,
    );
  }
  if (
    card.status === "done" &&
    !["resolved", "baseline", "cancelled"].includes(card.resolution)
  ) {
    errors.push(
      `${path}.resolution must be resolved, baseline, or cancelled when status is done`,
    );
  }
  if (card.status === "blocked") {
    if (!isRecord(card.blocker)) {
      errors.push(`${path}.blocker is required when status is blocked`);
    }
    if (!["blocked", "deferred"].includes(card.resolution)) {
      errors.push(
        `${path}.resolution must be blocked or deferred when status is blocked`,
      );
    }
  }

  const checks = Array.isArray(card.verification?.checks)
    ? card.verification.checks
    : [];
  const evidence = Array.isArray(card.evidence) ? card.evidence : [];
  if (card.status === "done" && card.resolution === "resolved") {
    if (!checks.some((check) => check?.status === "passed")) {
      errors.push(`${path} requires a passing check for done + resolved`);
    }
    if (evidence.length === 0) {
      errors.push(`${path} requires evidence for done + resolved`);
    }
  }
  if (
    card.status === "done" &&
    card.resolution === "baseline" &&
    evidence.length === 0
  ) {
    errors.push(`${path} requires evidence for done + baseline`);
  }
  if (
    card.status === "done" &&
    card.resolution === "cancelled" &&
    !hasCancellationReason(card)
  ) {
    errors.push(`${path} requires a cancellation reason for done + cancelled`);
  }

  const evidenceIds = new Set(
    evidence.filter(isRecord).map((item) => item.id).filter(Boolean),
  );
  for (const [evidenceIndex, item] of evidence.entries()) {
    if (
      isTimestamp(item?.captured_at) &&
      isTimestamp(card.updated_at) &&
      Date.parse(item.captured_at) > Date.parse(card.updated_at)
    ) {
      errors.push(
        `${path}.evidence[${evidenceIndex}].captured_at must not be newer than card.updated_at`,
      );
    }
  }
  for (const [checkIndex, check] of checks.entries()) {
    if (!Array.isArray(check?.evidence_refs)) {
      continue;
    }
    for (const evidenceRef of check.evidence_refs) {
      if (!evidenceIds.has(evidenceRef)) {
        errors.push(
          `${path}.verification.checks[${checkIndex}].evidence_refs references missing evidence ${evidenceRef}`,
        );
      }
    }
  }

  if (card.origin?.type === "human-feedback") {
    if (!card.origin.source_ref) {
      errors.push(`${path}.origin.source_ref is required for human feedback`);
    } else if (
      !Array.isArray(card.learning_refs) ||
      !card.learning_refs.includes(card.origin.source_ref)
    ) {
      errors.push(
        `${path}.learning_refs must include the human feedback source_ref`,
      );
    }
  }
}

function validateExecutionProfileInvariants(boardDocument, errors) {
  if (!isVisualBrowserProfile(boardDocument)) {
    return;
  }

  const metadata = boardDocument.board;
  const profile = metadata.execution_profile;
  const capability = profile.browser_capability;
  const visualCards = Array.isArray(boardDocument.cards)
    ? boardDocument.cards.filter(isVisualCard)
    : [];

  if (visualCards.length === 0) {
    errors.push(
      "$.board.execution_profile requires at least one card with a browser verification check",
    );
  }
  if (!visualCards.some((card) => card?.kind === "flow")) {
    errors.push(
      "$.board.execution_profile requires a flow card created before visual execution",
    );
  }

  for (const [field, value] of [
    ["requested_at", profile.requested_at],
    ["browser_capability.checked_at", capability?.checked_at],
  ]) {
    if (
      isTimestamp(value) &&
      isTimestamp(metadata.updated_at) &&
      Date.parse(value) > Date.parse(metadata.updated_at)
    ) {
      errors.push(
        `$.board.execution_profile.${field} must not be newer than board.updated_at`,
      );
    }
  }
  if (
    isTimestamp(profile.requested_at) &&
    isTimestamp(capability?.checked_at) &&
    Date.parse(capability.checked_at) < Date.parse(profile.requested_at)
  ) {
    errors.push(
      "$.board.execution_profile.browser_capability.checked_at must not precede requested_at",
    );
  }

  collectSensitiveStringErrors(
    profile,
    "$.board.execution_profile",
    errors,
  );

  for (const [index, card] of boardDocument.cards.entries()) {
    if (!isVisualCard(card)) {
      continue;
    }
    const path = `$.cards[${index}]`;
    const cardEvidence = Array.isArray(card.evidence) ? card.evidence : [];
    const cardChecks = Array.isArray(card.verification?.checks)
      ? card.verification.checks
      : [];
    if (!isRecord(card.reproduction)) {
      errors.push(
        `${path}.reproduction is required for visual scenario and finding cards`,
      );
    }
    collectSensitiveStringErrors(card, path, errors);
    validateVisualEvidenceReferences(card, path, errors);

    if (capability?.status !== "available") {
      if (card.status !== "blocked") {
        errors.push(
          `${path}.status must be blocked when browser capability is ${capability?.status ?? "invalid"}`,
        );
      }
      if (card.resolution !== "blocked") {
        errors.push(
          `${path}.resolution must be blocked when browser capability is not available`,
        );
      }
      if (card.classification !== "environment-blocker") {
        errors.push(
          `${path}.classification must be environment-blocker when browser capability is not available`,
        );
      }
      if (card.blocker?.kind !== "environment") {
        errors.push(
          `${path}.blocker.kind must be environment when browser capability is not available`,
        );
      }
      const browserChecks = cardChecks.filter(
        (check) => check?.type === "browser",
      );
      if (browserChecks.some((check) => check.status !== "blocked")) {
        errors.push(
          `${path} browser checks must be blocked when browser capability is not available`,
        );
      }
      if (
        cardEvidence.some((item) =>
          ["browser-observation", "screenshot-ref"].includes(item?.type),
        )
      ) {
        errors.push(
          `${path}.evidence must not claim browser observations or screenshots without available capability`,
        );
      }
    }

    if (card.status === "done" && card.resolution === "resolved") {
      const evidenceById = new Map(
        cardEvidence.filter(isRecord).map((item) => [item.id, item]),
      );
      const passingBrowserChecks = cardChecks.filter(
        (check) => check?.type === "browser" && check?.status === "passed",
      );
      if (passingBrowserChecks.length === 0) {
        errors.push(`${path} requires a passing browser check for visual done`);
      }
      const linkedVisualEvidence = passingBrowserChecks.flatMap((check) =>
        Array.isArray(check.evidence_refs)
          ? check.evidence_refs
              .map((id) => evidenceById.get(id))
              .filter((item) =>
                ["browser-observation", "screenshot-ref"].includes(item?.type),
              )
          : [],
      );
      if (linkedVisualEvidence.length === 0) {
        errors.push(
          `${path} requires browser or screenshot evidence linked from the passing browser check`,
        );
      }
    }
  }
}

function isVisualCard(card) {
  return Boolean(
    Array.isArray(card?.verification?.checks) &&
      card.verification.checks.some((check) => check?.type === "browser"),
  );
}

function validateVisualEvidenceReferences(card, path, errors) {
  if (!Array.isArray(card.evidence)) {
    return;
  }
  for (const [index, item] of card.evidence.entries()) {
    if (!isRecord(item)) {
      continue;
    }
    const evidencePath = `${path}.evidence[${index}]`;
    if (item.type === "screenshot-ref" && !item.ref) {
      errors.push(`${evidencePath}.ref is required for visual screenshots`);
      continue;
    }
    if (
      typeof item.ref === "string" &&
      !item.ref.startsWith("https://") &&
      !item.ref.startsWith("visual/")
    ) {
      errors.push(
        `${evidencePath}.ref must stay under the run visual/ directory`,
      );
    }
    if (
      item.type === "screenshot-ref" &&
      typeof item.ref === "string" &&
      !item.ref.startsWith("visual/screenshots/")
    ) {
      errors.push(
        `${evidencePath}.ref must stay under visual/screenshots/`,
      );
    }
  }
}

function collectSensitiveStringErrors(value, path, errors) {
  if (typeof value === "string") {
    const findings = detectSensitiveText(value);
    for (const finding of findings) {
      errors.push(`${path} contains unredacted ${finding}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      collectSensitiveStringErrors(item, `${path}[${index}]`, errors),
    );
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    collectSensitiveStringErrors(child, `${path}.${key}`, errors);
  }
}

function detectSensitiveText(value) {
  const text = String(value);
  const findings = [];
  if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(text)) {
    findings.push("email address");
  }
  if (
    /\b01[016789]\d{7,8}\b/.test(text.replace(/[ .()-]/g, "")) ||
    /(?:^|\D)(?:0\d{1,2})[-. ]\d{3,4}[-. ]\d{4}(?:\D|$)/.test(text)
  ) {
    findings.push("phone number");
  }
  const secretPattern =
    /(?:authorization\s*:\s*bearer|set-cookie\s*:|cookie\s*:|(?:password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?token)\s*[=:])\s*([^\s,;]+)/gi;
  for (const match of text.matchAll(secretPattern)) {
    const candidate = String(match[1] ?? "");
    if (!/^(?:\[?redacted\]?|<redacted>|\*{3,})$/i.test(candidate)) {
      findings.push("credential, cookie, or token value");
      break;
    }
  }
  return findings;
}

function hasCancellationReason(card) {
  const historyReasons = Array.isArray(card.history)
    ? card.history.map((event) => event?.reason ?? "").join(" ")
    : "";
  const cancellationText =
    `${card.next_action ?? ""} ${historyReasons}`.toLowerCase();
  return (
    cancellationText.includes("cancel") ||
    cancellationText.includes("duplicate") ||
    cancellationText.includes("취소") ||
    cancellationText.includes("중복")
  );
}

function validateFutureRule(rule, path, errors) {
  if (!isRecord(rule)) {
    errors.push(`${path} must be an object`);
    return;
  }
  validateExactObject(
    rule,
    path,
    ["trigger", "checks", "expected_evidence"],
    ["trigger", "checks", "expected_evidence"],
    errors,
  );
  validateString(rule.trigger, `${path}.trigger`, errors, {
    min: 1,
    max: 2000,
  });
  validateStringArray(rule.checks, `${path}.checks`, errors, {
    minItems: 1,
    maxString: 2000,
  });
  validateStringArray(
    rule.expected_evidence,
    `${path}.expected_evidence`,
    errors,
    { minItems: 1, maxString: 2000 },
  );
}

function validatePrivacy(privacy, path, errors) {
  if (!isRecord(privacy)) {
    errors.push(`${path} must be an object`);
    return;
  }
  validateExactObject(
    privacy,
    path,
    ["redacted"],
    ["redacted", "notes"],
    errors,
  );
  validateConst(privacy.redacted, true, `${path}.redacted`, errors);
  validateString(privacy.notes, `${path}.notes`, errors, {
    min: 0,
    max: 1000,
    optional: true,
  });
}

// 공유 가능한 상대경로나 credential 없는 public HTTPS만 evidence ref로 허용한다.
function validateEvidenceReference(value, path, errors) {
  if (value === undefined) {
    return;
  }
  validateString(value, path, errors, { min: 1, max: 1000 });
  if (typeof value !== "string" || value.length === 0) {
    return;
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    errors.push(`${path} must not contain control characters`);
    return;
  }

  if (value.startsWith("https://")) {
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      errors.push(`${path} must be a valid public HTTPS URL`);
      return;
    }
    if (parsed.username || parsed.password) {
      errors.push(`${path} must not contain URL credentials`);
    }
    const credentialKeyPattern =
      /(?:^|[_-])(token|key|secret|password|passwd|auth|authorization|signature|credential|session)(?:$|[_-])/i;
    if (
      [...parsed.searchParams.keys()].some((key) =>
        credentialKeyPattern.test(key),
      ) ||
      credentialKeyPattern.test(parsed.hash)
    ) {
      errors.push(`${path} must not contain credential-bearing URL parameters`);
    }
    if (!isPublicHostname(parsed.hostname)) {
      errors.push(`${path} must not target localhost or a private network`);
    }
    return;
  }

  if (
    value.startsWith("/") ||
    value.startsWith("\\") ||
    value.startsWith("~") ||
    value.startsWith("//") ||
    value.startsWith("?") ||
    value.startsWith("#") ||
    value.includes("?") ||
    value.includes("#") ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)
  ) {
    errors.push(`${path} must be a safe relative path or public HTTPS URL`);
    return;
  }
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(value).replaceAll("\\", "/");
  } catch {
    errors.push(`${path} relative path must use valid URL encoding`);
    return;
  }
  if (/[\u0000-\u001f\u007f]/.test(decodedPath)) {
    errors.push(`${path} decoded relative path must not contain controls`);
    return;
  }
  if (
    decodedPath.startsWith("/") ||
    decodedPath.startsWith("~") ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(decodedPath) ||
    decodedPath.includes("?") ||
    decodedPath.includes("#")
  ) {
    errors.push(`${path} decoded relative path is not safe`);
    return;
  }
  const normalizedSegments = decodedPath.split("/");
  if (normalizedSegments.some((segment) => segment === ".." || segment === "")) {
    errors.push(`${path} relative path must not be empty or traverse parents`);
  }
}

// DNS 조회 없이도 명백한 loopback, link-local, private 주소를 차단한다.
function isPublicHostname(hostname) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal") ||
    normalized.endsWith(".lan") ||
    normalized.endsWith(".home.arpa") ||
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("ff") ||
    normalized.startsWith("2001:db8") ||
    /^fe[89ab]/.test(normalized)
  ) {
    return false;
  }
  if (normalized.includes(":")) {
    return isPublicIpv6(normalized);
  }
  const ipv4Parts = normalized.split(".").map(Number);
  if (
    ipv4Parts.length === 4 &&
    ipv4Parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
  ) {
    return isPublicIpv4Parts(ipv4Parts);
  }
  return normalized.includes(".");
}

// IPv4의 사설·loopback·link-local·multicast·예약 범위를 한곳에서 판정한다.
function isPublicIpv4Parts([first, second]) {
  return !(
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    first >= 224
  );
}

// 축약/확장 IPv6를 8개 16-bit group으로 정규화해 private 범위를 판정한다.
function isPublicIpv6(address) {
  const halves = address.split("::");
  if (halves.length > 2) {
    return false;
  }
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missingCount = 8 - left.length - right.length;
  if (missingCount < 0 || (halves.length === 1 && missingCount !== 0)) {
    return false;
  }
  const groupStrings =
    halves.length === 2
      ? [...left, ...Array(missingCount).fill("0"), ...right]
      : left;
  const groups = groupStrings.map((group) => Number.parseInt(group || "0", 16));
  if (
    groups.length !== 8 ||
    groups.some(
      (group) => !Number.isInteger(group) || group < 0 || group > 0xffff,
    )
  ) {
    return false;
  }

  const isUnspecified = groups.every((group) => group === 0);
  const isLoopback =
    groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1;
  const first = groups[0];
  const isUniqueLocal = (first & 0xfe00) === 0xfc00;
  const isLinkLocal = (first & 0xffc0) === 0xfe80;
  const isMulticast = (first & 0xff00) === 0xff00;
  const isDocumentation = first === 0x2001 && groups[1] === 0x0db8;
  const isIpv4Mapped =
    groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
  if (isIpv4Mapped) {
    return isPublicIpv4Parts([
      groups[6] >> 8,
      groups[6] & 0xff,
      groups[7] >> 8,
      groups[7] & 0xff,
    ]);
  }
  return !(
    isUnspecified ||
    isLoopback ||
    isUniqueLocal ||
    isLinkLocal ||
    isMulticast ||
    isDocumentation
  );
}

function validateExactObject(value, path, required, allowed, errors) {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return;
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      errors.push(`${path}.${key} is required`);
    }
  }
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      errors.push(`${path}.${key} is not allowed`);
    }
  }
}

function validateString(value, path, errors, options = {}) {
  const { min = 0, max = Number.POSITIVE_INFINITY, optional = false } = options;
  if (optional && value === undefined) {
    return;
  }
  if (typeof value !== "string") {
    errors.push(`${path} must be a string`);
    return;
  }
  if (value.length < min) {
    errors.push(`${path} must contain at least ${min} characters`);
  }
  if (value.length > max) {
    errors.push(`${path} must contain at most ${max} characters`);
  }
}

function validateStringArray(value, path, errors, options = {}) {
  const {
    minItems = 0,
    maxString = Number.POSITIVE_INFINITY,
    unique = false,
  } = options;
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`);
    return;
  }
  if (value.length < minItems) {
    errors.push(`${path} must contain at least ${minItems} item(s)`);
  }
  const seen = new Set();
  for (const [index, item] of value.entries()) {
    validateString(item, `${path}[${index}]`, errors, {
      min: 1,
      max: maxString,
    });
    if (unique && typeof item === "string") {
      if (seen.has(item)) {
        errors.push(`${path}[${index}] duplicates ${item}`);
      }
      seen.add(item);
    }
  }
}

function validateId(value, path, errors) {
  validateString(value, path, errors, { min: 1, max: 100 });
  if (typeof value === "string" && !ID_PATTERN.test(value)) {
    errors.push(`${path} must match ${ID_PATTERN}`);
  }
}

function validateTimestamp(value, path, errors) {
  if (!isTimestamp(value)) {
    errors.push(`${path} must be an ISO 8601 date-time with timezone`);
  }
}

function validateEnum(value, allowed, path, errors) {
  if (!allowed.includes(value)) {
    errors.push(`${path} must be one of: ${allowed.join(", ")}`);
  }
}

function validateConst(value, expected, path, errors) {
  if (value !== expected) {
    errors.push(`${path} must equal ${JSON.stringify(expected)}`);
  }
}

function isTimestamp(value) {
  return (
    typeof value === "string" &&
    TIMESTAMP_PATTERN.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// JSON.parse가 덮어쓰는 중복 키를 원문 토큰 단계에서 찾아 감사 의미 손실을 막는다.
function collectDuplicateJsonKeyErrors(text) {
  const errors = [];
  let index = 0;

  const skipWhitespace = () => {
    while (/\s/.test(text[index] ?? "")) {
      index += 1;
    }
  };

  const parseStringToken = () => {
    const start = index;
    index += 1;
    while (index < text.length) {
      if (text[index] === "\\") {
        index += 2;
        continue;
      }
      if (text[index] === '"') {
        index += 1;
        return JSON.parse(text.slice(start, index));
      }
      index += 1;
    }
    return "";
  };

  const parseValue = (path) => {
    skipWhitespace();
    if (text[index] === "{") {
      parseObject(path);
      return;
    }
    if (text[index] === "[") {
      parseArray(path);
      return;
    }
    if (text[index] === '"') {
      parseStringToken();
      return;
    }
    while (
      index < text.length &&
      ![",", "]", "}"].includes(text[index]) &&
      !/\s/.test(text[index])
    ) {
      index += 1;
    }
  };

  const parseObject = (path) => {
    index += 1;
    skipWhitespace();
    const keys = new Set();
    if (text[index] === "}") {
      index += 1;
      return;
    }
    while (index < text.length) {
      skipWhitespace();
      const key = parseStringToken();
      const keyPath = `${path}[${JSON.stringify(key)}]`;
      if (keys.has(key)) {
        errors.push(`${keyPath} is a duplicate JSON object key`);
      }
      keys.add(key);
      skipWhitespace();
      index += 1;
      parseValue(keyPath);
      skipWhitespace();
      if (text[index] === "}") {
        index += 1;
        return;
      }
      index += 1;
    }
  };

  const parseArray = (path) => {
    index += 1;
    skipWhitespace();
    if (text[index] === "]") {
      index += 1;
      return;
    }
    let itemIndex = 0;
    while (index < text.length) {
      parseValue(`${path}[${itemIndex}]`);
      itemIndex += 1;
      skipWhitespace();
      if (text[index] === "]") {
        index += 1;
        return;
      }
      index += 1;
    }
  };

  parseValue("$");
  return errors;
}

function collectDangerousKeyErrors(value, path, errors) {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      collectDangerousKeyErrors(item, `${path}[${index}]`, errors),
    );
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  for (const key of Object.keys(value)) {
    if (DANGEROUS_KEYS.has(key)) {
      errors.push(`${path}.${key} is a forbidden object key`);
    }
    collectDangerousKeyErrors(value[key], `${path}.${key}`, errors);
  }
}
