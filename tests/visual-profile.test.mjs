import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ValidationError,
  assertValidBoard,
  isVisualBrowserProfile,
  parseUntrustedJson,
} from "../skills/agent-qa-kanban/scripts/board-lib.mjs";
import { buildCursorCanvasSource } from "../skills/agent-qa-kanban/scripts/hosts/cursor-canvas.mjs";
import { renderMarkdownBoard } from "../skills/agent-qa-kanban/scripts/render-markdown-lib.mjs";
import {
  normalizeVisualArtifactPath,
  prepareVisualArtifacts,
  writeVisualArtifact,
} from "../skills/agent-qa-kanban/scripts/visual-artifacts.mjs";

const projectDirectory = fileURLToPath(new URL("..", import.meta.url));
const visualExamplePath = resolve(
  projectDirectory,
  "examples/qa-board.visual.example.json",
);
const legacyExamplePath = resolve(
  projectDirectory,
  "examples/qa-board.example.json",
);
const testRoot = resolve(projectDirectory, ".tmp/visual-profile-tests");

async function readBoard(path = visualExamplePath) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function createRunFixture(board = null) {
  await mkdir(testRoot, { recursive: true });
  const runDirectory = await mkdtemp(join(testRoot, "run-"));
  const boardPath = join(runDirectory, "qa-board.json");
  await writeFile(
    boardPath,
    `${JSON.stringify(board ?? (await readBoard()), null, 2)}\n`,
    "utf8",
  );
  return { runDirectory, boardPath };
}

function makeAvailableBoard(board) {
  const result = structuredClone(board);
  const capability = result.board.execution_profile.browser_capability;
  capability.status = "available";
  capability.probe_method = "runtime-tool-inventory";
  capability.summary = "The runtime exposes a verified browser interaction tool.";

  const card = result.cards[0];
  card.status = "done";
  card.resolution = "resolved";
  card.classification = "passed-check";
  card.reproduction.actual =
    "The checkout journey completed through visible user interactions.";
  card.verification.checks[0] = {
    id: "CHECK-VISUAL-001",
    type: "browser",
    status: "passed",
    summary: "Checkout interaction and validation passed.",
    evidence_refs: ["EVIDENCE-VISUAL-001"],
  };
  card.evidence = [
    {
      id: "EVIDENCE-VISUAL-001",
      type: "screenshot-ref",
      summary: "Redacted checkout confirmation after UI navigation.",
      ref: "visual/screenshots/checkout-confirmation.png",
      captured_at: "2026-08-07T01:04:00Z",
      redacted: true,
    },
  ];
  delete card.blocker;
  card.next_action = "No further action for this scenario.";
  card.history = [
    {
      at: "2026-08-07T01:02:00Z",
      actor: "qa-agent",
      from: "queued",
      to: "investigating",
      reason: "Started the visual scenario after capability verification.",
    },
    {
      at: "2026-08-07T01:03:00Z",
      actor: "qa-agent",
      from: "investigating",
      to: "verifying",
      reason: "Completed the interaction path and began evidence review.",
    },
    {
      at: "2026-08-07T01:05:00Z",
      actor: "qa-agent",
      from: "verifying",
      to: "done",
      reason: "Passing browser evidence satisfies the visual criteria.",
    },
  ];
  return result;
}

test("legacy 1.0 boards remain valid and do not activate visual QA", async () => {
  const board = await readBoard(legacyExamplePath);
  assert.equal(board.schema_version, "1.0");
  assert.equal(isVisualBrowserProfile(board), false);
  assert.equal(assertValidBoard(board), board);
});

test("visual profile validates and survives an untrusted JSON round trip", async () => {
  const board = await readBoard();
  assert.equal(isVisualBrowserProfile(board), true);
  assert.equal(assertValidBoard(board), board);
  const roundTripped = parseUntrustedJson(JSON.stringify(board));
  assert.deepEqual(roundTripped, board);
  assert.equal(assertValidBoard(roundTripped), roundTripped);
});

test("visual profile requires explicit activation and schema 1.1", async () => {
  const implicit = await readBoard();
  implicit.board.execution_profile.activation = "automatic";
  assert.throws(
    () => assertValidBoard(implicit),
    (error) =>
      error instanceof ValidationError &&
      error.message.includes("explicit-user-request"),
  );

  const oldVersion = await readBoard();
  oldVersion.schema_version = "1.0";
  assert.throws(
    () => assertValidBoard(oldVersion),
    (error) =>
      error instanceof ValidationError &&
      error.message.includes("requires schema_version 1.1"),
  );
});

test("unavailable and unverified capability keep visual cards blocked", async () => {
  const unavailable = await readBoard();
  assert.equal(assertValidBoard(unavailable), unavailable);

  const unverified = await readBoard();
  unverified.board.execution_profile.browser_capability.status = "unverified";
  unverified.board.execution_profile.browser_capability.probe_method =
    "runtime-not-verifiable";
  assert.equal(assertValidBoard(unverified), unverified);

  const dishonest = makeAvailableBoard(await readBoard());
  dishonest.board.execution_profile.browser_capability.status = "unavailable";
  dishonest.board.execution_profile.browser_capability.probe_method =
    "runtime-tool-unavailable";
  assert.throws(
    () => assertValidBoard(dishonest),
    (error) =>
      error instanceof ValidationError &&
      error.message.includes("must be blocked") &&
      error.message.includes("must not claim"),
  );
});

test("available capability rejects manifest-style or mismatched claims", async () => {
  const board = makeAvailableBoard(await readBoard());
  board.board.execution_profile.browser_capability.probe_method =
    "runtime-tool-unavailable";
  assert.throws(
    () => assertValidBoard(board),
    (error) =>
      error instanceof ValidationError &&
      error.message.includes("cannot support status available"),
  );
});

test("visual done requires browser evidence linked to its passing check", async () => {
  const board = makeAvailableBoard(await readBoard());
  assert.equal(assertValidBoard(board), board);

  board.cards[0].verification.checks[0].evidence_refs = [];
  assert.throws(
    () => assertValidBoard(board),
    (error) =>
      error instanceof ValidationError &&
      error.message.includes("linked from the passing browser check"),
  );
});

test("visual scenarios and findings share canonical reproduction and evidence links", async () => {
  const board = makeAvailableBoard(await readBoard());
  const finding = structuredClone(board.cards[0]);
  finding.id = "QA-VISUAL-FINDING-001";
  finding.kind = "finding";
  finding.title = "Validation message shifts the checkout actions";
  finding.summary = "The invalid-form message changes the action layout.";
  finding.status = "investigating";
  finding.resolution = "unresolved";
  finding.classification = "confirmed-bug";
  finding.severity = "medium";
  finding.reproduction.actual =
    "The action row shifts after the validation message appears.";
  finding.verification.checks = [
    {
      id: "CHECK-VISUAL-FINDING-001",
      type: "browser",
      status: "failed",
      summary: "The invalid-form interaction reproduced the layout shift.",
      evidence_refs: ["EVIDENCE-VISUAL-FINDING-001"],
    },
  ];
  finding.evidence = [
    {
      id: "EVIDENCE-VISUAL-FINDING-001",
      type: "browser-observation",
      summary: "Redacted DOM and visual observation of the shifted action row.",
      ref: "visual/evidence/validation-layout.md",
      captured_at: "2026-08-07T01:04:00Z",
      redacted: true,
    },
  ];
  finding.next_action = "Trace the layout rule and decide whether a fix is approved.";
  finding.related_cards = ["QA-VISUAL-001"];
  finding.history = [
    {
      at: "2026-08-07T01:04:00Z",
      actor: "qa-agent",
      from: "queued",
      to: "investigating",
      reason: "Recorded the defect immediately after browser reproduction.",
    },
  ];
  finding.updated_at = "2026-08-07T01:05:00Z";
  board.cards[0].related_cards = [finding.id];
  board.cards.push(finding);

  assert.equal(assertValidBoard(board), board);
  assert.equal(board.cards[1].reproduction.expected.length > 0, true);
  assert.deepEqual(
    board.cards[1].verification.checks[0].evidence_refs,
    [board.cards[1].evidence[0].id],
  );
});

test("visual evidence stays in the derived visual directory", async () => {
  const board = makeAvailableBoard(await readBoard());
  board.cards[0].evidence[0].ref = "evidence/checkout.png";
  assert.throws(
    () => assertValidBoard(board),
    (error) =>
      error instanceof ValidationError &&
      error.message.includes("run visual/ directory"),
  );

  const remoteScreenshot = makeAvailableBoard(await readBoard());
  remoteScreenshot.cards[0].evidence[0].ref =
    "https://example.com/checkout.png";
  assert.throws(
    () => assertValidBoard(remoteScreenshot),
    (error) =>
      error instanceof ValidationError &&
      error.message.includes("visual/screenshots/"),
  );
});

test("derived visual summary escapes raw HTML and Markdown syntax", async () => {
  const board = makeAvailableBoard(await readBoard());
  board.cards[0].title = "<img src=x onerror=alert(1)> | visual";
  const nonVisual = structuredClone(board.cards[0]);
  nonVisual.id = "QA-STATIC-001";
  nonVisual.title = "Non-visual static contract";
  nonVisual.verification.checks[0].id = "CHECK-STATIC-001";
  nonVisual.verification.checks[0].type = "static";
  nonVisual.evidence[0].id = "EVIDENCE-STATIC-001";
  nonVisual.evidence[0].type = "static-trace";
  nonVisual.verification.checks[0].evidence_refs = [nonVisual.evidence[0].id];
  board.cards.push(nonVisual);
  const { runDirectory, boardPath } = await createRunFixture(board);
  try {
    const result = await prepareVisualArtifacts({ boardPath });
    const summary = await readFile(result.summaryPath, "utf8");
    assert.doesNotMatch(summary, /<img src=/);
    assert.ok(summary.includes("&lt;img src=x onerror=alert\\(1\\)&gt;"));
    assert.match(summary, /\\\| visual/);
    assert.match(summary, /- Cards: 1/);
    assert.match(summary, /- Done: 1/);
  } finally {
    await rm(runDirectory, { recursive: true, force: true });
  }
});

test("visual profile rejects high-signal credentials, cookies, and PII", async () => {
  const samples = [
    "Authorization: Bearer secret-value-12345",
    "cookie: session-value-12345",
    "access_token=secret-value-12345",
    "Contact qa.person@example.com for the screenshot",
    "Call 010-1234-5678 for the account",
  ];
  for (const sample of samples) {
    const board = makeAvailableBoard(await readBoard());
    board.cards[0].evidence[0].summary = sample;
    assert.throws(
      () => assertValidBoard(board),
      (error) =>
        error instanceof ValidationError &&
        error.message.includes("contains unredacted"),
      sample,
    );
  }
});

test("malformed visual evidence reports validation errors without TypeError", async () => {
  const board = await readBoard();
  board.cards[0].evidence = {};
  assert.throws(
    () => assertValidBoard(board),
    (error) =>
      error instanceof ValidationError &&
      error.message.includes("evidence must be an array"),
  );
});

test("audit-only visual artifacts are run-local and do not mutate canonical JSON", async () => {
  const board = await readBoard();
  const { runDirectory, boardPath } = await createRunFixture(board);
  try {
    const before = createHash("sha256")
      .update(await readFile(boardPath))
      .digest("hex");
    const result = await prepareVisualArtifacts({ boardPath });
    const after = createHash("sha256")
      .update(await readFile(boardPath))
      .digest("hex");
    assert.equal(after, before);
    assert.equal(result.visualRoot, join(runDirectory, "visual"));
    assert.match(await readFile(result.summaryPath, "utf8"), /not canonical/);
    assert.equal(board.board.execution_profile.server_policy, "observe-only");
  } finally {
    await rm(runDirectory, { recursive: true, force: true });
  }
});

test("plan-only mode rejects derived artifact writes", async () => {
  const board = await readBoard();
  board.board.mode = "plan-only";
  const { runDirectory, boardPath } = await createRunFixture(board);
  try {
    await assert.rejects(
      () => prepareVisualArtifacts({ boardPath, board }),
      /does not authorize derived artifact writes/,
    );
  } finally {
    await rm(runDirectory, { recursive: true, force: true });
  }
});

test("unavailable capability cannot write browser evidence artifacts", async () => {
  const { runDirectory, boardPath } = await createRunFixture();
  try {
    await prepareVisualArtifacts({ boardPath });
    await assert.rejects(
      () =>
        writeVisualArtifact({
          boardPath,
          relativePath: "screenshots/not-executed.png",
          content: Buffer.from("fabricated"),
        }),
      /require available browser capability/,
    );
  } finally {
    await rm(runDirectory, { recursive: true, force: true });
  }
});

test("portable visual paths reject traversal, absolute paths, and canonical names", () => {
  assert.equal(
    normalizeVisualArtifactPath("screenshots\\step-01.png"),
    "screenshots/step-01.png",
  );
  for (const unsafe of [
    "../qa-board.json",
    "screenshots/../../qa-board.json",
    "/tmp/proof.png",
    "C:\\temp\\proof.png",
    "C:temp\\proof.png",
    "\\\\server\\share\\proof.png",
    "screenshots/NUL.png",
    "screenshots/trailing-dot.",
    "qa-board.json",
  ]) {
    assert.throws(
      () => normalizeVisualArtifactPath(unsafe),
      /not allowed|relative|collide|portable/,
    );
  }
});

test("visual writes reject symlink directory escapes", async (context) => {
  const { runDirectory, boardPath } = await createRunFixture(
    makeAvailableBoard(await readBoard()),
  );
  const externalDirectory = await mkdtemp(join(testRoot, "outside-"));
  try {
    await prepareVisualArtifacts({ boardPath });
    await rm(join(runDirectory, "visual/screenshots"), {
      recursive: true,
      force: true,
    });
    try {
      await symlink(
        externalDirectory,
        join(runDirectory, "visual/screenshots"),
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch (error) {
      if (
        process.platform === "win32" &&
        ["EPERM", "EACCES", "UNKNOWN"].includes(error?.code)
      ) {
        context.skip("Windows runner does not grant symlink or junction creation");
        return;
      }
      throw error;
    }
    await assert.rejects(
      () =>
        writeVisualArtifact({
          boardPath,
          relativePath: "screenshots/proof.png",
          content: Buffer.from("not-an-image"),
        }),
      /symlink directory/,
    );
  } finally {
    await rm(runDirectory, { recursive: true, force: true });
    await rm(externalDirectory, { recursive: true, force: true });
  }
});

test("visual writes reject hardlinks and canonical aliases", async () => {
  const { runDirectory, boardPath } = await createRunFixture(
    makeAvailableBoard(await readBoard()),
  );
  const externalPath = join(testRoot, `outside-${Date.now()}.txt`);
  try {
    await prepareVisualArtifacts({ boardPath });
    await writeFile(externalPath, "outside", "utf8");
    const hardlinkPath = join(runDirectory, "visual/evidence/shared.txt");
    await link(externalPath, hardlinkPath);
    await assert.rejects(
      () =>
        writeVisualArtifact({
          boardPath,
          relativePath: "evidence/shared.txt",
          content: "replacement",
        }),
      /hardlinked visual artifact/,
    );

    const aliasPath = join(runDirectory, "visual/evidence/board-alias.json");
    await link(boardPath, aliasPath);
    await assert.rejects(
      () =>
        writeVisualArtifact({
          boardPath,
          relativePath: "evidence/board-alias.json",
          content: "replacement",
        }),
      /hardlink to canonical/,
    );
  } finally {
    await rm(runDirectory, { recursive: true, force: true });
    await unlink(externalPath).catch(() => {});
  }
});

test("all renderers expose the optional profile without changing the board", async () => {
  const board = await readBoard();
  const before = JSON.stringify(board);
  const markdown = renderMarkdownBoard(board);
  assert.ok(markdown.includes("Execution profile: visual\\-browser"));
  assert.match(markdown, /Browser capability: unavailable/);

  const cursorSource = await buildCursorCanvasSource(board);
  assert.match(cursorSource, /execution_profile/);
  assert.match(cursorSource, /visual-browser/);

  const { runDirectory, boardPath } = await createRunFixture(board);
  try {
    const renderScript = resolve(
      projectDirectory,
      "skills/agent-qa-kanban/scripts/render-board.mjs",
    );
    for (const mode of ["standalone", "fragment", "claude-inline"]) {
      const outputPath = join(runDirectory, `${mode}.html`);
      execFileSync(
        process.execPath,
        [renderScript, boardPath, outputPath, "--mode", mode],
        { encoding: "utf8" },
      );
      const output = await readFile(outputPath, "utf8");
      assert.match(output, /visual-browser/, mode);
      assert.match(output, /unavailable/, mode);
    }
  } finally {
    await rm(runDirectory, { recursive: true, force: true });
  }
  assert.equal(JSON.stringify(board), before);
});
