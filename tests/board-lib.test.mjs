import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  BOARD_MODES,
  CARD_CLASSIFICATIONS,
  CARD_RESOLUTIONS,
  CARD_STATUSES,
  CHANGE_SCOPES,
  QA_LANES,
  ValidationError,
  assertValidBoard,
  assertValidHumanLearningEntry,
  parseUntrustedJson,
  summarizeBoard,
} from "../skills/agent-qa-kanban/scripts/board-lib.mjs";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const projectDirectory = resolve(testDirectory, "..");

// 공개 예제는 스키마와 상태 불변식을 모두 만족해야 한다.
test("example board validates and derives counts", async () => {
  const board = JSON.parse(
    await readFile(
      resolve(projectDirectory, "examples/qa-board.example.json"),
      "utf8",
    ),
  );
  assert.equal(assertValidBoard(board), board);
  assert.deepEqual(summarizeBoard(board).byStatus, {
    queued: 0,
    investigating: 1,
    fixing: 0,
    verifying: 1,
    done: 1,
    blocked: 1,
  });
});

// JSON 경계에서 프로토타입 오염 키를 거부해야 한다.
test("untrusted JSON rejects dangerous keys recursively", () => {
  assert.throws(
    () =>
      parseUntrustedJson(
        '{"board":{"nested":{"__proto__":{"polluted":true}}}}',
        "dangerous fixture",
      ),
    (error) =>
      error instanceof ValidationError &&
      error.message.includes("forbidden object key"),
  );
});

// 동일 키가 두 번 나온 JSON은 마지막 값으로 조용히 덮어쓰지 않는다.
test("untrusted JSON rejects duplicate object keys", () => {
  assert.throws(
    () =>
      parseUntrustedJson(
        '{"source":"human-feedback","source":"agent-observation"}',
        "duplicate fixture",
      ),
    (error) =>
      error instanceof ValidationError &&
      error.message.includes("duplicate JSON object key"),
  );
});

// 완료 카드는 실제 통과 검증과 증거가 없으면 완료로 인정하지 않는다.
test("done resolved card requires passing evidence", async () => {
  const board = await readExampleBoard();
  board.cards[0].verification.checks[0].status = "failed";
  board.cards[0].evidence = [];
  assert.throws(
    () => assertValidBoard(board),
    (error) =>
      error instanceof ValidationError &&
      error.message.includes("requires a passing check") &&
      error.message.includes("requires evidence"),
  );
});

// audit-only 실행에서는 과거 이력까지 fixing 상태를 사용할 수 없다.
test("audit-only board rejects fixing transitions", async () => {
  const board = await readExampleBoard();
  board.board.mode = "audit-only";
  assert.throws(
    () => assertValidBoard(board),
    (error) =>
      error instanceof ValidationError &&
      error.message.includes("does not authorize implementation"),
  );
});

// write-tests 모드는 제품 수정이 아닌 테스트 구현을 fixing으로 추적할 수 있다.
test("write-tests board permits a fixing test card", async () => {
  const board = await readExampleBoard();
  board.board.mode = "write-tests";
  board.cards[1].change_scope = "tests-only";
  assert.equal(assertValidBoard(board), board);
});

// write-tests 모드가 product 변경 권한으로 확대되는 것을 구조적으로 막는다.
test("write-tests board rejects approved product scope", async () => {
  const board = await readExampleBoard();
  board.board.mode = "write-tests";
  assert.throws(
    () => assertValidBoard(board),
    (error) =>
      error instanceof ValidationError &&
      error.message.includes("cannot authorize product changes"),
  );
});

// 상태 이력의 연결과 마지막 상태는 카드의 현재 상태와 일치해야 한다.
test("history rejects disconnected transitions", async () => {
  const board = await readExampleBoard();
  board.cards[1].history[2].from = "queued";
  assert.throws(
    () => assertValidBoard(board),
    (error) =>
      error instanceof ValidationError &&
      error.message.includes("previous history event"),
  );
});

// 첫 이력은 canonical 생성 상태인 queued에서 시작해야 한다.
test("history must begin from queued", async () => {
  const board = await readExampleBoard();
  board.cards[2].history[0].from = "investigating";
  assert.throws(
    () => assertValidBoard(board),
    (error) =>
      error instanceof ValidationError &&
      error.message.includes("must start from queued"),
  );
});

// 실행 가능한 기준과 검증 항목이 없는 카드는 보드에 들어갈 수 없다.
test("every card requires acceptance criteria and a verification check", async () => {
  const board = await readExampleBoard();
  board.cards[2].verification.acceptance_criteria = [];
  board.cards[2].verification.checks = [];
  assert.throws(
    () => assertValidBoard(board),
    (error) =>
      error instanceof ValidationError &&
      error.message.includes("acceptance_criteria") &&
      error.message.includes("checks must contain at least 1 item"),
  );
});

// non-passing 카드에는 expected/actual 재현 계약과 시작 이력이 필요하다.
test("non-passing active cards require reproduction and history", async () => {
  const board = await readExampleBoard();
  delete board.cards[2].reproduction;
  board.cards[2].history = [];
  assert.throws(
    () => assertValidBoard(board),
    (error) =>
      error instanceof ValidationError &&
      error.message.includes("reproduction is required") &&
      error.message.includes("history is required"),
  );
});

// 깨진 배열 타입은 런타임 예외가 아니라 일관된 검증 오류로 수집해야 한다.
test("malformed card arrays produce validation errors without TypeError", async () => {
  const historyBoard = await readExampleBoard();
  historyBoard.cards[1].history = {};
  assert.throws(
    () => assertValidBoard(historyBoard),
    (error) =>
      error instanceof ValidationError &&
      error.message.includes("history must be an array"),
  );

  const learningBoard = await readExampleBoard();
  learningBoard.cards[0].origin = {
    type: "human-feedback",
    source_ref: "HQA-CHECKOUT-001",
  };
  learningBoard.cards[0].learning_refs = {};
  assert.throws(
    () => assertValidBoard(learningBoard),
    (error) =>
      error instanceof ValidationError &&
      error.message.includes("learning_refs must be an array"),
  );
});

// evidence ref는 private/credential/scheme 경로를 공유 가능한 근거로 받지 않는다.
test("evidence references reject credentials, private URLs, and unsafe schemes", async () => {
  const unsafeReferences = [
    "https://user:secret@example.com/proof",
    "https://example.com/proof?api_key=secret",
    "https://127.0.0.1/proof",
    "https://192.168.1.20/proof",
    "https://service.internal/proof",
    "https://[::ffff:127.0.0.1]/proof",
    "https://[0:0:0:0:0:0:0:1]/proof",
    "https://127.1/proof",
    "file:///private/proof.png",
    "javascript:alert(1)",
    "../private/proof.png",
    "evidence/%2e%2e/private.png",
    "evidence/%5c..%5cprivate.png",
    "evidence/%2f..%2fprivate.png",
    "evidence/proof%0a.txt",
  ];
  for (const reference of unsafeReferences) {
    const board = await readExampleBoard();
    board.cards[0].evidence[0].ref = reference;
    assert.throws(
      () => assertValidBoard(board),
      (error) =>
        error instanceof ValidationError &&
        error.message.includes("evidence[0].ref"),
      reference,
    );
  }
});

// 인간 학습은 명시적 인간 피드백과 redacted 표시가 모두 있어야 한다.
test("human learning entry enforces provenance and redaction", async () => {
  const entry = JSON.parse(
    await readFile(
      resolve(projectDirectory, "examples/human-feedback.example.json"),
      "utf8",
    ),
  );
  assert.equal(assertValidHumanLearningEntry(entry), entry);
  entry.source = "agent-observation";
  entry.privacy.redacted = false;
  assert.throws(
    () => assertValidHumanLearningEntry(entry),
    (error) =>
      error instanceof ValidationError &&
      error.message.includes('must equal "human-feedback"') &&
      error.message.includes("privacy.redacted"),
  );
});

// supersedes는 현재 항목 자신을 가리킬 수 없다.
test("human learning entry rejects self-superseding provenance", async () => {
  const entry = JSON.parse(
    await readFile(
      resolve(projectDirectory, "examples/human-feedback.example.json"),
      "utf8",
    ),
  );
  entry.status = "superseded";
  entry.supersedes = [entry.id];
  assert.throws(
    () => assertValidHumanLearningEntry(entry),
    (error) =>
      error instanceof ValidationError &&
      error.message.includes("must not reference the entry itself"),
  );
});

// 깨진 supersedes 타입도 includes 호출 예외 없이 검증 오류로 보고해야 한다.
test("malformed human supersedes produces a validation error", async () => {
  const entry = JSON.parse(
    await readFile(
      resolve(projectDirectory, "examples/human-feedback.example.json"),
      "utf8",
    ),
  );
  entry.status = "superseded";
  entry.supersedes = {};
  assert.throws(
    () => assertValidHumanLearningEntry(entry),
    (error) =>
      error instanceof ValidationError &&
      error.message.includes("supersedes must be an array"),
  );
});

// 공개 JSON Schema의 핵심 enum이 실행 시 검증기와 어긋나지 않게 고정한다.
test("public schema enums stay aligned with the runtime validator", async () => {
  const boardSchema = JSON.parse(
    await readFile(
      resolve(
        projectDirectory,
        "skills/agent-qa-kanban/references/qa-board.schema.json",
      ),
      "utf8",
    ),
  );
  const humanSchema = JSON.parse(
    await readFile(
      resolve(
        projectDirectory,
        "skills/agent-qa-kanban/references/human-qa-entry.schema.json",
      ),
      "utf8",
    ),
  );
  assert.deepEqual(boardSchema.$defs.board.properties.mode.enum, BOARD_MODES);
  assert.deepEqual(boardSchema.$defs.board.properties.lane.enum, QA_LANES);
  assert.deepEqual(boardSchema.$defs.card.properties.status.enum, CARD_STATUSES);
  assert.deepEqual(
    boardSchema.$defs.card.properties.resolution.enum,
    CARD_RESOLUTIONS,
  );
  assert.deepEqual(
    boardSchema.$defs.card.properties.classification.enum,
    CARD_CLASSIFICATIONS,
  );
  assert.deepEqual(
    boardSchema.$defs.card.properties.change_scope.enum,
    CHANGE_SCOPES,
  );
  assert.equal(
    boardSchema.$defs.verification.properties.acceptance_criteria.minItems,
    1,
  );
  assert.equal(boardSchema.$defs.verification.properties.checks.minItems, 1);
  assert.equal(boardSchema.$defs.board.properties.locale.maxLength, 35);
  assert.equal(
    boardSchema.$defs.surface.properties.routes.items.minLength,
    1,
  );
  assert.equal(
    boardSchema.$defs.check.properties.evidence_refs.items.minLength,
    1,
  );
  assert.equal(
    boardSchema.$defs.card.properties.learning_refs.items.minLength,
    1,
  );
  assert.deepEqual(
    boardSchema.$defs.origin.allOf[0].then.required,
    ["source_ref"],
  );
  assert.equal(boardSchema.$defs.evidence.properties.ref.minLength, 1);
  assert.equal(
    boardSchema.$defs.card.properties.history.prefixItems[0].allOf[1]
      .properties.from.const,
    "queued",
  );
  assert.deepEqual(
    boardSchema.$defs.card.allOf[1].then.required,
    ["reproduction"],
  );
  assert.equal(humanSchema.properties.source.const, "human-feedback");
  assert.equal(humanSchema.properties.pattern_ids.minItems, 1);
  assert.equal(humanSchema.properties.pattern_ids.items.minLength, 1);
  assert.equal(humanSchema.properties.evidence_refs.items.minLength, 1);
  assert.equal(humanSchema.properties.related_card_ids.items.minLength, 1);
  assert.equal(humanSchema.properties.supersedes.items.minLength, 1);
  assert.deepEqual(humanSchema.allOf[0].then.required, ["supersedes"]);
  assert.equal(humanSchema.properties.privacy.properties.redacted.const, true);
});

async function readExampleBoard() {
  return JSON.parse(
    await readFile(
      resolve(projectDirectory, "examples/qa-board.example.json"),
      "utf8",
    ),
  );
}
