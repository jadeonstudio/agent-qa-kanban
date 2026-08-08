import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { link, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { readSafeJson } from "../skills/agent-qa-kanban/scripts/board-lib.mjs";
import {
  CURSOR_SURFACES,
  detectCanvasHost,
  detectCursorAgentCli,
  detectCursorRuntimeSession,
  detectCursorSkillInstall,
  listCursorSkillCandidates,
  probeCursorCapabilities,
} from "../skills/agent-qa-kanban/scripts/hosts/cursor-capabilities.mjs";
import {
  assertDistinctOutputPaths,
  assertSafeCanvasSource,
  buildCursorCanvasSource,
  renderCursorBoard,
} from "../skills/agent-qa-kanban/scripts/hosts/cursor-canvas.mjs";

const exampleBoardPath = fileURLToPath(
  new URL("../examples/qa-board.example.json", import.meta.url),
);
const repoTmpRoot = fileURLToPath(
  new URL("../.tmp/cursor-tests", import.meta.url),
);

async function loadExampleBoard() {
  return readSafeJson(exampleBoardPath, exampleBoardPath);
}

async function makeFixtureHome() {
  await mkdir(repoTmpRoot, { recursive: true });
  return mkdtemp(join(repoTmpRoot, "aqk-cursor-"));
}

const cursorSessionEnv = {
  PATH: "",
  CURSOR_AGENT: "1",
  CURSOR_CONVERSATION_ID: "test-conversation",
};

test("Cursor skill install detects .cursor and .agents skill roots", () => {
  const homeDir = "/virtual-home";
  const cwd = "/virtual-cwd";
  const candidates = listCursorSkillCandidates({ homeDir, cwd });
  assert.deepEqual(candidates, [
    join(cwd, ".cursor", "skills", "agent-qa-kanban"),
    join(cwd, ".agents", "skills", "agent-qa-kanban"),
    join(homeDir, ".cursor", "skills", "agent-qa-kanban"),
    join(homeDir, ".agents", "skills", "agent-qa-kanban"),
  ]);

  const agentsSkillMd = join(
    cwd,
    ".agents",
    "skills",
    "agent-qa-kanban",
    "SKILL.md",
  );
  const found = detectCursorSkillInstall({
    homeDir,
    cwd,
    pathExists: (path) => path === agentsSkillMd,
    realpath: (path) => path,
  });
  assert.equal(found.installed, true);
  assert.equal(found.root, join(cwd, ".agents", "skills", "agent-qa-kanban"));
});

test("Canvas host detection requires built-in canvas skill", () => {
  const homeDir = "/virtual-home";
  const missing = detectCanvasHost({
    homeDir,
    pathExists: () => false,
  });
  assert.equal(missing.available, false);

  const skillMd = join(
    homeDir,
    ".cursor",
    "skills-cursor",
    "canvas",
    "SKILL.md",
  );
  const found = detectCanvasHost({
    homeDir,
    pathExists: (path) => path === skillMd,
  });
  assert.equal(found.available, true);
});

test("runtime session requires Cursor env signals", () => {
  const inactive = detectCursorRuntimeSession({ env: { PATH: "" } });
  assert.equal(inactive.active, false);

  const active = detectCursorRuntimeSession({
    env: { CURSOR_AGENT: "1" },
  });
  assert.equal(active.active, true);
  assert.ok(active.signals.includes("CURSOR_AGENT"));
});

test("gate requires skill install, canvas host, and Cursor runtime", () => {
  const homeDir = "/virtual-home";
  const cwd = "/virtual-cwd";
  const skillMd = join(
    homeDir,
    ".cursor",
    "skills",
    "agent-qa-kanban",
    "SKILL.md",
  );
  const canvasMd = join(
    homeDir,
    ".cursor",
    "skills-cursor",
    "canvas",
    "SKILL.md",
  );
  const pathExists = (path) => path === skillMd || path === canvasMd;

  const filesOnly = probeCursorCapabilities({
    homeDir,
    cwd,
    env: { PATH: "" },
    pathExists,
    realpath: (path) => path,
  });
  assert.equal(filesOnly.gate.allowed, false);
  assert.equal(filesOnly.gate.cursorRuntimeActive, false);
  assert.equal(filesOnly.selectedSurface, CURSOR_SURFACES.MARKDOWN_FALLBACK);

  const allowed = probeCursorCapabilities({
    homeDir,
    cwd,
    env: cursorSessionEnv,
    pathExists,
    realpath: (path) => path,
  });
  assert.equal(allowed.gate.allowed, true);
  assert.equal(allowed.gate.cursorRuntimeActive, true);
  assert.equal(allowed.selectedSurface, CURSOR_SURFACES.CURSOR_CANVAS);
});

test("unverified PATH agent binaries are ignored", () => {
  const result = detectCursorAgentCli({
    env: { PATH: "/tmp/fake-bin" },
    pathExists: (path) => path.endsWith("/agent"),
    realpath: (path) => path.replace(/cursor-agent$/, "agent"),
  });
  assert.equal(result.present, false);
  assert.equal(result.trusted, false);
});

test("trusted cursor-agent binary is recorded", () => {
  const binary = "/opt/cursor/cursor-agent";
  const result = detectCursorAgentCli({
    env: { PATH: "/opt/cursor" },
    pathExists: (path) => path === binary,
    realpath: (path) => path,
  });
  assert.equal(result.present, true);
  assert.equal(result.trusted, true);
  assert.equal(result.binary, binary);
});

test("canvas generator embeds board and keeps template-only safety checks", async () => {
  const board = await loadExampleBoard();
  const poisoned = structuredClone(board);
  poisoned.board.title = "Checkout fetch( should not trip safety";
  poisoned.cards[0].title = "Uses WebSocket wording in title only";

  const source = await buildCursorCanvasSource(poisoned);
  assertSafeCanvasSource(source);
  assert.match(source, /from "cursor\/canvas"/);
  assert.match(source, /Checkout fetch\(/);
  assert.match(source, /overflowX: "hidden"/);
  assert.match(source, /aria-label=\{copy\.detail\}/);
  assert.doesNotMatch(source, /aria-modal/);
  assert.doesNotMatch(source, /inset: 0/);
  assert.match(source, /blocker\.kind/);
  assert.match(source, /buildContinuePrompt|Copy continue prompt|이 카드 프롬프트 복사/);
  assert.doesNotMatch(source, /sendFollowUpMessage/);
  assert.doesNotMatch(source, /newComposerChat/);
  assert.doesNotMatch(source, /%%BOARD_JSON%%/);
});

test("assertDistinctOutputPaths refuses canonical overwrite", () => {
  const boardPath = "/tmp/qa-board.json";
  assert.throws(
    () =>
      assertDistinctOutputPaths({
        boardPath,
        outPath: boardPath,
      }),
    /must be different/,
  );
  assert.throws(
    () =>
      assertDistinctOutputPaths({
        boardPath,
        reportPath: "/tmp/./qa-board.json",
      }),
    /must be different/,
  );
  assert.throws(
    () =>
      assertDistinctOutputPaths({
        outPath: "/tmp/same-output.json",
        reportPath: "/tmp/same-output.json",
      }),
    /colliding outputs/,
  );
  assert.doesNotThrow(() =>
    assertDistinctOutputPaths({
      boardPath,
      outPath: "/tmp/qa-board.canvas.tsx",
      markdownOutPath: "/tmp/qa-board.md",
      reportPath: "/tmp/report.json",
    }),
  );
});

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

test("renderCursorBoard falls back to markdown when gate fails", async () => {
  const board = await loadExampleBoard();
  const outDir = await makeFixtureHome();
  try {
    const report = await renderCursorBoard({
      board,
      boardPath: join(outDir, "canonical.json"),
      markdownOutPath: join(outDir, "board.md"),
      reportPath: join(outDir, "report.json"),
      force: false,
      probeOptions: {
        homeDir: outDir,
        cwd: outDir,
        env: { PATH: "" },
        pathExists: () => false,
      },
    });
    assert.equal(report.selectedSurface, CURSOR_SURFACES.MARKDOWN_FALLBACK);
    assert.equal(report.outputs.canvas, null);
    assert.ok(report.outputs.markdown);
    assert.match(report.markdown, /Checkout release QA/);
    const markdown = await readFile(report.outputs.markdown, "utf8");
    assert.match(markdown, /Checkout release QA/);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test("renderCursorBoard keeps markdown in memory without markdown-out", async () => {
  const board = await loadExampleBoard();
  const report = await renderCursorBoard({
    board,
    force: false,
    probeOptions: {
      homeDir: "/nope",
      cwd: "/nope",
      env: { PATH: "" },
      pathExists: () => false,
    },
  });
  assert.equal(report.selectedSurface, CURSOR_SURFACES.MARKDOWN_FALLBACK);
  assert.equal(report.outputs.markdown, "(stdout or in-memory)");
  assert.match(report.markdown, /## blocked/);
});

test("renderCursorBoard writes canvas when forced", async () => {
  const board = await loadExampleBoard();
  const outDir = await makeFixtureHome();
  try {
    const canvasPath = join(outDir, "qa-kanban-run-20260730-001.canvas.tsx");
    const report = await renderCursorBoard({
      board,
      boardPath: join(outDir, "canonical.json"),
      outPath: canvasPath,
      reportPath: join(outDir, "report.json"),
      force: true,
      probeOptions: {
        homeDir: outDir,
        cwd: outDir,
        env: { PATH: "" },
        pathExists: () => false,
      },
    });
    assert.equal(report.selectedSurface, CURSOR_SURFACES.CURSOR_CANVAS);
    assert.equal(report.outputs.canvas, canvasPath);
    const source = await readFile(canvasPath, "utf8");
    assertSafeCanvasSource(source);
    assert.match(source, /QA-FLOW-001/);
    assert.match(source, /blocker\.kind/);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test("CLI refuses to overwrite the input board path", async () => {
  const outDir = await makeFixtureHome();
  const boardPath = join(outDir, "qa-board.json");
  await writeFile(
    boardPath,
    await readFile(exampleBoardPath, "utf8"),
    "utf8",
  );
  const before = await readFile(boardPath, "utf8");
  const board = await loadExampleBoard();
  await assert.rejects(
    () =>
      renderCursorBoard({
        board,
        boardPath,
        outPath: boardPath,
        force: true,
      }),
    /must be different/,
  );
  const after = await readFile(boardPath, "utf8");
  assert.equal(after, before);
  await rm(outDir, { recursive: true, force: true });
});

test("renderCursorBoard refuses symlink --out aliasing the board", async (context) => {
  const outDir = await makeFixtureHome();
  try {
    const boardPath = join(outDir, "qa-board.json");
    const outPath = join(outDir, "alias.canvas.tsx");
    const boardText = await readFile(exampleBoardPath, "utf8");
    await writeFile(boardPath, boardText, "utf8");
    try {
      await symlink(boardPath, outPath);
    } catch (error) {
      if (
        process.platform === "win32" &&
        ["EPERM", "EACCES", "UNKNOWN"].includes(error?.code)
      ) {
        context.skip("Windows runner does not grant file symlink creation");
        return;
      }
      throw error;
    }
    const beforeHash = sha256(await readFile(boardPath, "utf8"));
    const board = await loadExampleBoard();
    await assert.rejects(
      () =>
        renderCursorBoard({
          board,
          boardPath,
          outPath,
          force: true,
        }),
      /must be different/,
    );
    assert.equal(sha256(await readFile(boardPath, "utf8")), beforeHash);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test("renderCursorBoard refuses hardlink --out aliasing the board", async () => {
  const outDir = await makeFixtureHome();
  try {
    const boardPath = join(outDir, "qa-board.json");
    const outPath = join(outDir, "hardlink.canvas.tsx");
    const boardText = await readFile(exampleBoardPath, "utf8");
    await writeFile(boardPath, boardText, "utf8");
    await link(boardPath, outPath);
    const beforeHash = sha256(await readFile(boardPath, "utf8"));
    const board = await loadExampleBoard();
    await assert.rejects(
      () =>
        renderCursorBoard({
          board,
          boardPath,
          outPath,
          force: true,
        }),
      /must be different/,
    );
    assert.equal(sha256(await readFile(boardPath, "utf8")), beforeHash);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test("renderCursorBoard refuses identical --out and --report paths", async () => {
  const outDir = await makeFixtureHome();
  try {
    const sharedPath = join(outDir, "shared-output.json");
    const board = await loadExampleBoard();
    await assert.rejects(
      () =>
        renderCursorBoard({
          board,
          outPath: sharedPath,
          reportPath: sharedPath,
          force: true,
        }),
      /colliding outputs/,
    );
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
