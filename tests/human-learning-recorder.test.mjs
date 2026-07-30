import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const projectDirectory = resolve(testDirectory, "..");
const recorderPath = resolve(
  projectDirectory,
  "skills/agent-qa-kanban/scripts/record-human-learning.mjs",
);
const validatorPath = resolve(
  projectDirectory,
  "skills/agent-qa-kanban/scripts/validate-human-learning.mjs",
);
const entryPath = resolve(
  projectDirectory,
  "examples/human-feedback.example.json",
);

// 공개 CLI가 예제 인간 QA 항목을 read-only로 검증한다.
test("human learning validator CLI accepts the public example", () => {
  const result = spawnSync(process.execPath, [validatorPath, entryPath], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Valid human QA learning entry/);
});

// recorder는 새 JSONL 파일에 검증된 한 줄만 append한다.
test("human learning recorder appends a validated JSONL entry", async () => {
  const temporaryDirectory = await mkdtemp(
    resolve(tmpdir(), "agent-qa-kanban-learning-"),
  );
  const logPath = resolve(temporaryDirectory, "human-qa-learning.jsonl");
  const result = runRecorder(logPath);
  assert.equal(result.status, 0, result.stderr);
  await assert.rejects(readFile(`${logPath}.lock`, "utf8"), { code: "ENOENT" });
  const lines = (await readFile(logPath, "utf8")).trim().split(/\r?\n/);
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).id, "HQA-CHECKOUT-001");
});

// 같은 ID를 두 번 기록해 append-only provenance가 모호해지는 것을 막는다.
test("human learning recorder rejects duplicate IDs without appending", async () => {
  const temporaryDirectory = await mkdtemp(
    resolve(tmpdir(), "agent-qa-kanban-learning-duplicate-"),
  );
  const logPath = resolve(temporaryDirectory, "human-qa-learning.jsonl");
  assert.equal(runRecorder(logPath).status, 0);
  const secondResult = runRecorder(logPath);
  assert.equal(secondResult.status, 1);
  assert.match(secondResult.stderr, /already exists/);
  const lines = (await readFile(logPath, "utf8")).trim().split(/\r?\n/);
  assert.equal(lines.length, 1);
});

// 기존 마지막 줄에 newline이 없어도 새 항목이 같은 줄에 붙지 않아야 한다.
test("human learning recorder repairs a missing trailing newline", async () => {
  const temporaryDirectory = await mkdtemp(
    resolve(tmpdir(), "agent-qa-kanban-learning-newline-"),
  );
  const logPath = resolve(temporaryDirectory, "human-qa-learning.jsonl");
  const existingEntry = JSON.parse(await readFile(entryPath, "utf8"));
  existingEntry.id = "HQA-CHECKOUT-OLDER";
  await writeFile(logPath, JSON.stringify(existingEntry), "utf8");

  const result = runRecorder(logPath);
  assert.equal(result.status, 0, result.stderr);
  const lines = (await readFile(logPath, "utf8")).trim().split(/\r?\n/);
  assert.equal(lines.length, 2);
  assert.deepEqual(
    lines.map((line) => JSON.parse(line).id),
    ["HQA-CHECKOUT-OLDER", "HQA-CHECKOUT-001"],
  );
});

// 이미 recorder가 lock을 보유한 동안에는 두 번째 writer가 append하지 않는다.
test("human learning recorder refuses a concurrently locked log", async () => {
  const temporaryDirectory = await mkdtemp(
    resolve(tmpdir(), "agent-qa-kanban-learning-lock-"),
  );
  const logPath = resolve(temporaryDirectory, "human-qa-learning.jsonl");
  await writeFile(`${logPath}.lock`, "", "utf8");
  const result = runRecorder(logPath);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /is locked/);
  await assert.rejects(readFile(logPath, "utf8"), { code: "ENOENT" });
});

// supersedes는 자신이나 미래 ID가 아니라 기존의 더 오래된 항목만 가리킨다.
test("human learning recorder validates append-only supersedes references", async () => {
  const temporaryDirectory = await mkdtemp(
    resolve(tmpdir(), "agent-qa-kanban-learning-supersedes-"),
  );
  const logPath = resolve(temporaryDirectory, "human-qa-learning.jsonl");
  assert.equal(runRecorder(logPath).status, 0);

  const replacement = JSON.parse(await readFile(entryPath, "utf8"));
  replacement.id = "HQA-CHECKOUT-002";
  replacement.supersedes = ["HQA-CHECKOUT-001"];
  const replacementPath = resolve(temporaryDirectory, "replacement.json");
  await writeFile(replacementPath, JSON.stringify(replacement), "utf8");
  assert.equal(runRecorder(logPath, replacementPath).status, 0);

  replacement.id = "HQA-CHECKOUT-003";
  replacement.supersedes = ["HQA-MISSING"];
  const invalidPath = resolve(temporaryDirectory, "invalid.json");
  await writeFile(invalidPath, JSON.stringify(replacement), "utf8");
  const invalidResult = runRecorder(logPath, invalidPath);
  assert.equal(invalidResult.status, 1);
  assert.match(invalidResult.stderr, /does not exist/);
  const lines = (await readFile(logPath, "utf8")).trim().split(/\r?\n/);
  assert.equal(lines.length, 2);
});

function runRecorder(logPath, inputPath = entryPath) {
  return spawnSync(process.execPath, [recorderPath, logPath, inputPath], {
    encoding: "utf8",
  });
}
