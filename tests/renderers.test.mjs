import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const projectDirectory = resolve(testDirectory, "..");
const scriptDirectory = resolve(
  projectDirectory,
  "skills/agent-qa-kanban/scripts",
);
const exampleBoardPath = resolve(
  projectDirectory,
  "examples/qa-board.example.json",
);

// fragment 자산의 실행 스크립트는 브라우저에 넣기 전에 문법적으로 유효해야 한다.
test("fragment runtime script parses as JavaScript", async () => {
  const asset = await readFile(
    resolve(
      projectDirectory,
      "skills/agent-qa-kanban/assets/board-fragment.html",
    ),
    "utf8",
  );
  const scriptMatches = [
    ...asset.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g),
  ];
  assert.ok(scriptMatches.length >= 2);
  assert.doesNotThrow(
    () => new Function(scriptMatches.at(-1)[1]),
  );
});

// fragment는 Codex inline 제한을 지키고 외부 네트워크나 위험 DOM API를 사용하지 않는다.
test("fragment renderer produces a bounded inline-safe visualization", async () => {
  const temporaryDirectory = await mkdtemp(
    resolve(tmpdir(), "agent-qa-kanban-render-"),
  );
  const outputPath = resolve(temporaryDirectory, "board-fragment.html");
  runRenderer(exampleBoardPath, outputPath, "fragment");
  const output = await readFile(outputPath, "utf8");
  const lowerOutput = output.toLowerCase();

  assert.equal(lowerOutput.includes("<!doctype"), false);
  assert.equal(lowerOutput.includes("<html"), false);
  assert.equal(lowerOutput.includes("<head"), false);
  assert.equal(lowerOutput.includes("<body"), false);
  assert.equal(output.includes("fetch("), false);
  assert.equal(output.includes("XMLHttpRequest"), false);
  assert.equal(output.includes("WebSocket"), false);
  assert.equal(output.includes("innerHTML"), false);
  assert.equal(output.includes("document.currentScript"), false);
  assert.equal(lowerOutput.includes("position: fixed"), false);
  assert.equal(lowerOutput.includes("100vh"), false);
  assert.equal(lowerOutput.includes("overflow-x"), false);
  assert.equal(/#[0-9a-f]{3,8}\b/i.test(output), false);
  assert.ok(Buffer.byteLength(output, "utf8") < 2 * 1024 * 1024);
  assert.match(output, /window\.openai\?\.sendFollowUpMessage/);
  assert.match(
    output,
    /document\.getElementById\("aqk-[0-9a-f]{8}-[0-9a-f]{8}"\)/,
  );
  assert.match(output, /textContent/);
});

// 동일 보드를 여러 번 렌더해 한 host 문서에 넣어도 DOM ID가 겹치지 않는다.
test("repeated renders receive unique instance IDs", async () => {
  const temporaryDirectory = await mkdtemp(
    resolve(tmpdir(), "agent-qa-kanban-unique-id-"),
  );
  const firstPath = resolve(temporaryDirectory, "first.html");
  const secondPath = resolve(temporaryDirectory, "second.html");
  runRenderer(exampleBoardPath, firstPath, "fragment");
  runRenderer(exampleBoardPath, secondPath, "fragment");
  const first = await readFile(firstPath, "utf8");
  const second = await readFile(secondPath, "utf8");
  const idPattern = /id="(aqk-[0-9a-f]{8}-[0-9a-f]{8})"/;
  const firstId = first.match(idPattern)?.[1];
  const secondId = second.match(idPattern)?.[1];
  assert.ok(firstId);
  assert.ok(secondId);
  assert.notEqual(firstId, secondId);
});

// 보드 문자열은 script 종료 태그를 만들 수 없도록 JSON 직렬화 시 이스케이프된다.
test("renderer neutralizes script-closing text from board data", async () => {
  const temporaryDirectory = await mkdtemp(
    resolve(tmpdir(), "agent-qa-kanban-injection-"),
  );
  const maliciousBoardPath = resolve(temporaryDirectory, "board.json");
  const outputPath = resolve(temporaryDirectory, "board.html");
  const board = JSON.parse(await readFile(exampleBoardPath, "utf8"));
  board.cards[0].title = '</script><script data-attack="true">attack()</script>';
  await writeFile(maliciousBoardPath, JSON.stringify(board), "utf8");

  runRenderer(maliciousBoardPath, outputPath, "fragment");
  const output = await readFile(outputPath, "utf8");
  assert.equal(output.includes('<script data-attack="true">'), false);
  assert.match(output, /\\u003c\/script\\u003e/);
});

// 잘못된 출력 경로로 canonical JSON 자체를 덮어쓰지 못하게 한다.
test("renderers refuse to overwrite the canonical input board", async () => {
  const temporaryDirectory = await mkdtemp(
    resolve(tmpdir(), "agent-qa-kanban-no-overwrite-"),
  );
  const boardPath = resolve(temporaryDirectory, "board.json");
  const original = await readFile(exampleBoardPath, "utf8");
  await writeFile(boardPath, original, "utf8");
  const result = spawnSync(
    process.execPath,
    [
      resolve(scriptDirectory, "render-board.mjs"),
      boardPath,
      boardPath,
      "--mode",
      "fragment",
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /must be different/);
  assert.equal(await readFile(boardPath, "utf8"), original);
});

// standalone 결과는 네트워크와 문서 권한을 차단하는 CSP를 포함한다.
test("standalone renderer adds CSP and document shell", async () => {
  const temporaryDirectory = await mkdtemp(
    resolve(tmpdir(), "agent-qa-kanban-standalone-"),
  );
  const outputPath = resolve(temporaryDirectory, "board.html");
  runRenderer(exampleBoardPath, outputPath, "standalone");
  const output = await readFile(outputPath, "utf8");
  assert.match(output, /^<!doctype html>/);
  assert.match(output, /Content-Security-Policy/);
  assert.match(output, /default-src 'none'/);
  assert.match(output, /connect-src 'none'/);
  assert.match(output, /object-src 'none'/);
  assert.match(output, /form-action 'none'/);
});

// locale은 standalone 문서 언어와 fragment의 한국어 UI 선택에 반영된다.
test("renderer preserves locale and includes Korean board labels", async () => {
  const temporaryDirectory = await mkdtemp(
    resolve(tmpdir(), "agent-qa-kanban-locale-"),
  );
  const koreanBoardPath = resolve(temporaryDirectory, "board-ko.json");
  const standalonePath = resolve(temporaryDirectory, "board-ko.html");
  const fragmentPath = resolve(temporaryDirectory, "board-ko-fragment.html");
  const board = JSON.parse(await readFile(exampleBoardPath, "utf8"));
  board.board.locale = "ko";
  await writeFile(koreanBoardPath, JSON.stringify(board), "utf8");
  runRenderer(koreanBoardPath, standalonePath, "standalone");
  runRenderer(koreanBoardPath, fragmentPath, "fragment");
  const standalone = await readFile(standalonePath, "utf8");
  const fragment = await readFile(fragmentPath, "utf8");
  assert.match(standalone, /<html lang="ko">/);
  assert.match(fragment, /lang="ko"/);
  assert.match(fragment, /QA 칸반 보드/);
  assert.match(fragment, /재현 단계/);
});

// Codex fragment가 커지면 잘라내지 않고 명시적으로 실패해야 한다.
test("fragment renderer rejects output at or above the 2 MB host limit", async () => {
  const temporaryDirectory = await mkdtemp(
    resolve(tmpdir(), "agent-qa-kanban-large-"),
  );
  const largeBoardPath = resolve(temporaryDirectory, "large-board.json");
  const outputPath = resolve(temporaryDirectory, "large-board.html");
  const board = JSON.parse(await readFile(exampleBoardPath, "utf8"));
  const baseCard = board.cards[2];
  board.cards = Array.from({ length: 540 }, (_, index) => ({
    ...structuredClone(baseCard),
    id: `QA-BULK-${String(index).padStart(3, "0")}`,
    summary: "x".repeat(4000),
    related_cards: [],
    learning_refs: [],
  }));
  await writeFile(largeBoardPath, JSON.stringify(board), "utf8");

  const result = spawnSync(
    process.execPath,
    [
      resolve(scriptDirectory, "render-board.mjs"),
      largeBoardPath,
      outputPath,
      "--mode",
      "fragment",
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /exceeds the 2 MB/);
});

// Markdown fallback도 모든 상태 그룹과 핵심 다음 행동을 보존한다.
test("Markdown renderer keeps complete board semantics", async () => {
  const temporaryDirectory = await mkdtemp(
    resolve(tmpdir(), "agent-qa-kanban-markdown-"),
  );
  const outputPath = resolve(temporaryDirectory, "board.md");
  execFileSync(
    process.execPath,
    [
      resolve(scriptDirectory, "render-markdown.mjs"),
      exampleBoardPath,
      outputPath,
    ],
    { encoding: "utf8" },
  );
  const output = await readFile(outputPath, "utf8");
  for (const status of [
    "queued",
    "investigating",
    "fixing",
    "verifying",
    "done",
    "blocked",
  ]) {
    assert.match(output, new RegExp(`## ${status}`));
  }
  assert.match(output, /QA\\-FE\\-001/);
  assert.match(output, /Next action:/);
  assert.match(output, /HQA\\-CHECKOUT\\-001/);
  assert.match(output, /Expected:/);
  assert.match(output, /Actual:/);
  assert.match(output, /Verification checks:/);
  assert.match(output, /Blocker:/);
  assert.match(output, /History:/);
});

function runRenderer(inputPath, outputPath, mode) {
  execFileSync(
    process.execPath,
    [
      resolve(scriptDirectory, "render-board.mjs"),
      inputPath,
      outputPath,
      "--mode",
      mode,
    ],
    { encoding: "utf8" },
  );
}
