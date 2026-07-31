#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertValidBoard,
  readSafeJson,
} from "../board-lib.mjs";
import { renderMarkdownBoard } from "../render-markdown-lib.mjs";
import {
  CURSOR_SURFACES,
  probeCursorCapabilities,
} from "./cursor-capabilities.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = resolve(
  __dirname,
  "../../assets/cursor-board.canvas.template.tsx",
);
const BOARD_MARKER = "%%BOARD_JSON%%";

// 보드를 검증하고 Cursor 게이트에 따라 Canvas 또는 Markdown을 만든다.
export async function renderCursorBoard(options) {
  const {
    board,
    boardPath = null,
    outPath = null,
    markdownOutPath = null,
    reportPath = null,
    force = false,
    probeOptions = {},
  } = options;

  assertValidBoard(board);
  assertDistinctOutputPaths({
    boardPath,
    outPath,
    markdownOutPath,
    reportPath,
  });

  const probe = probeCursorCapabilities(probeOptions);
  const gatePassed = force || probe.gate.allowed;
  const selectedSurface = gatePassed
    ? CURSOR_SURFACES.CURSOR_CANVAS
    : CURSOR_SURFACES.MARKDOWN_FALLBACK;

  const report = {
    selectedSurface,
    forced: Boolean(force),
    gate: probe.gate,
    reasons: force
      ? [...probe.reasons, "Render forced for tests or explicit override"]
      : probe.reasons,
    probe,
    outputs: {
      canvas: null,
      markdown: null,
    },
  };

  if (selectedSurface === CURSOR_SURFACES.CURSOR_CANVAS) {
    const source = await buildCursorCanvasSource(board);
    if (outPath) {
      const resolvedOut = resolve(outPath);
      await writeFileAtomicNoFollow(resolvedOut, source, "utf8");
      report.outputs.canvas = resolvedOut;
    } else {
      report.outputs.canvas = "(stdout or in-memory)";
    }
    report.canvasSource = outPath ? undefined : source;
  } else {
    const markdown = renderMarkdownBoard(board);
    if (markdownOutPath) {
      const resolvedMd = resolve(markdownOutPath);
      await writeFileAtomicNoFollow(resolvedMd, markdown, "utf8");
      report.outputs.markdown = resolvedMd;
    } else {
      report.outputs.markdown = "(stdout or in-memory)";
    }
    // CLI/호출자가 fallback 본문을 항상 받을 수 있게 메모리에도 유지한다.
    report.markdown = markdown;
  }

  if (reportPath) {
    const resolvedReport = resolve(reportPath);
    // report JSON에는 대형 markdown/canvas 본문을 넣지 않는다.
    const persisted = {
      selectedSurface: report.selectedSurface,
      forced: report.forced,
      gate: report.gate,
      reasons: report.reasons,
      probe: report.probe,
      outputs: report.outputs,
    };
    await writeFileAtomicNoFollow(
      resolvedReport,
      `${JSON.stringify(persisted, null, 2)}\n`,
      "utf8",
    );
    report.reportPath = resolvedReport;
  }

  return report;
}

// 경로의 resolve·realpath·inode 정체성을 수집한다 (존재하지 않으면 resolved만).
function collectPathIdentity(filePath) {
  const resolved = resolve(filePath);
  const identity = { resolved, real: null, inode: null };
  if (!existsSync(resolved)) {
    return identity;
  }
  try {
    identity.real = realpathSync(resolved);
  } catch {
    // realpath 실패 시 resolved 문자열 비교만 사용한다.
  }
  try {
    // hardlink는 realpath가 달라도 같은 inode를 공유한다.
    // symlink는 follow한 대상 inode로 잡아 정본과 동일 여부를 본다.
    const st = statSync(resolved);
    identity.inode = `${st.dev}:${st.ino}`;
  } catch {
    // 접근 불가면 inode 비교를 건너뛴다.
  }
  return identity;
}

// 두 경로가 같은 파일을 가리키면 true (절대경로 문자열·realpath·dev:ino).
function pathsShareIdentity(leftPath, rightPath) {
  const left = collectPathIdentity(leftPath);
  const right = collectPathIdentity(rightPath);
  if (left.resolved === right.resolved) {
    return true;
  }
  if (left.real && right.real && left.real === right.real) {
    return true;
  }
  if (left.inode && right.inode && left.inode === right.inode) {
    return true;
  }
  return false;
}

// 입력 정본과 출력 경로 alias, 그리고 출력끼리의 경로 충돌을 거부한다.
export function assertDistinctOutputPaths({
  boardPath,
  outPath,
  markdownOutPath,
  reportPath,
}) {
  const outputs = [
    ["--out", outPath],
    ["--markdown-out", markdownOutPath],
    ["--report", reportPath],
  ].filter(([, outputPath]) => Boolean(outputPath));

  // boardPath가 없어도 출력끼리 동일·symlink·hardlink면 거부한다.
  for (let index = 0; index < outputs.length; index += 1) {
    for (let other = index + 1; other < outputs.length; other += 1) {
      const [labelA, pathA] = outputs[index];
      const [labelB, pathB] = outputs[other];
      if (pathsShareIdentity(pathA, pathB)) {
        throw new Error(
          `Output paths ${labelA} and ${labelB} must be different (refusing colliding outputs)`,
        );
      }
    }
  }

  if (!boardPath) {
    return;
  }

  for (const [label, outputPath] of outputs) {
    if (pathsShareIdentity(boardPath, outputPath)) {
      throw new Error(
        `Input board and ${label} paths must be different (refusing to overwrite canonical JSON)`,
      );
    }
  }
}

// 심볼릭 링크를 follow하지 않고 같은 디렉터리 임시 파일에 쓴 뒤 rename으로 교체한다.
// darwin 등에서 O_NOFOLLOW가 있으면 임시 파일 open에 포함하고, 없으면 realpath/inode
// 사전 검사 + lstat(symlink 거부) + atomic rename에 의존한다 (플랫폼 미지원으로 작업을 막지 않음).
async function writeFileAtomicNoFollow(targetPath, content, encoding = "utf8") {
  const resolved = resolve(targetPath);
  await mkdir(dirname(resolved), { recursive: true });

  try {
    const existing = lstatSync(resolved);
    if (existing.isSymbolicLink()) {
      throw new Error(`Refusing to write through symlink at ${resolved}`);
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  const tempPath = join(
    dirname(resolved),
    `.${basename(resolved)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );

  let flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL;
  // O_NOFOLLOW가 없는 플랫폼에서는 플래그 없이 진행한다 (사전 identity·lstat가 주 방어선).
  if (fsConstants.O_NOFOLLOW) {
    flags |= fsConstants.O_NOFOLLOW;
  }

  let fd = null;
  try {
    fd = openSync(tempPath, flags, 0o644);
    const buffer = Buffer.isBuffer(content)
      ? content
      : Buffer.from(String(content), encoding);
    writeSync(fd, buffer);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    // rename은 디렉터리 엔트리를 교체하므로 symlink target을 follow하지 않는다.
    renameSync(tempPath, resolved);
  } catch (error) {
    if (fd != null) {
      try {
        closeSync(fd);
      } catch {
        // close 실패는 원인 오류를 가리지 않는다.
      }
    }
    try {
      unlinkSync(tempPath);
    } catch {
      // temp 정리 실패는 원인 오류를 가리지 않는다.
    }
    throw error;
  }
}

// 템플릿의 보드 슬롯에 검증된 JSON 리터럴을 끼워 넣는다.
export async function buildCursorCanvasSource(board) {
  assertValidBoard(board);
  const template = await readFile(TEMPLATE_PATH, "utf8");
  if (!template.includes(BOARD_MARKER)) {
    throw new Error(
      `Cursor canvas template is missing ${BOARD_MARKER} marker`,
    );
  }
  const markerCount = template.split(BOARD_MARKER).length - 1;
  if (markerCount !== 1) {
    throw new Error(
      `Cursor canvas template must contain exactly one ${BOARD_MARKER} marker`,
    );
  }
  // 보드 JSON이 들어가기 전 템플릿만 안전 검사한다 (임베드 데이터 오탐 방지).
  assertSafeCanvasTemplate(template);
  const jsonLiteral = JSON.stringify(board, null, 2);
  return template.replace(BOARD_MARKER, jsonLiteral);
}

/** @deprecated Prefer assertSafeCanvasTemplate; kept for generated-source callers. */
export function assertSafeCanvasSource(source) {
  if (source.includes(BOARD_MARKER)) {
    assertSafeCanvasTemplate(source);
    return;
  }
  // 임베드된 보드 JSON은 검사에서 제외한다 (제목의 fetch( 등 오탐 방지).
  const startMarker = "const BOARD = ";
  const endMarker = "\nconst STATUSES = ";
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(
      "Cannot isolate embedded board JSON for canvas safety scanning",
    );
  }
  const stripped =
    source.slice(0, start) +
    `const BOARD = ${BOARD_MARKER};` +
    source.slice(end);
  assertSafeCanvasTemplate(stripped);
}

// Canvas 템플릿 계약: cursor/canvas만 import하고 상태 변경 액션이 없다.
export function assertSafeCanvasTemplate(template) {
  const errors = [];
  if (
    !template.includes('from "cursor/canvas"') &&
    !template.includes("from 'cursor/canvas'")
  ) {
    errors.push('Canvas template must import from "cursor/canvas"');
  }
  const importBlocks =
    template.match(/import\s+[\s\S]*?from\s+["'][^"']+["']/g) ?? [];
  for (const block of importBlocks) {
    if (!/from\s+["']cursor\/canvas["']/.test(block)) {
      errors.push(
        `Disallowed import: ${block.replace(/\s+/g, " ").slice(0, 120)}`,
      );
    }
  }
  const forbidden = [
    "sendFollowUpMessage",
    "drag-and-drop",
    "draggable",
    "onDrag",
    "fetch(",
    "XMLHttpRequest",
    "WebSocket",
    "newComposerChat",
    "move card",
    "Fix this card",
    "Verify this card",
  ];
  for (const token of forbidden) {
    if (template.includes(token)) {
      errors.push(`Forbidden canvas token present: ${token}`);
    }
  }
  if (!template.includes("useCanvasState")) {
    errors.push(
      "Canvas template should use useCanvasState for local selection only",
    );
  }
  if (!template.includes(BOARD_MARKER)) {
    errors.push(`Canvas template must keep ${BOARD_MARKER} placeholder`);
  }
  if (errors.length > 0) {
    throw new Error(`Unsafe Cursor canvas template:\n- ${errors.join("\n- ")}`);
  }
}

function parseArgs(argv) {
  const args = {
    boardPath: null,
    outPath: null,
    markdownOutPath: null,
    reportPath: null,
    force: false,
  };
  const positionals = [];
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--out") {
      args.outPath = argv[++index];
    } else if (token === "--markdown-out") {
      args.markdownOutPath = argv[++index];
    } else if (token === "--report") {
      args.reportPath = argv[++index];
    } else if (token === "--force") {
      args.force = true;
    } else if (token.startsWith("-")) {
      throw new Error(`Unknown flag: ${token}`);
    } else {
      positionals.push(token);
    }
  }
  args.boardPath = positionals[0] ?? null;
  if (!args.boardPath || positionals.length > 1) {
    throw new Error(
      "Usage: cursor-canvas.mjs <board.json> [--out canvas.tsx] [--markdown-out board.md] [--report report.json] [--force]",
    );
  }
  return args;
}

const isMain =
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  try {
    const args = parseArgs(process.argv);
    const resolvedBoardPath = resolve(args.boardPath);
    const board = await readSafeJson(resolvedBoardPath, args.boardPath);
    const report = await renderCursorBoard({
      board,
      boardPath: resolvedBoardPath,
      outPath: args.outPath,
      markdownOutPath: args.markdownOutPath,
      reportPath: args.reportPath,
      force: args.force,
    });

    if (
      report.selectedSurface === CURSOR_SURFACES.CURSOR_CANVAS &&
      !args.outPath &&
      report.canvasSource
    ) {
      process.stdout.write(report.canvasSource);
    } else if (
      report.selectedSurface === CURSOR_SURFACES.MARKDOWN_FALLBACK &&
      !args.markdownOutPath &&
      report.markdown
    ) {
      // README가 약속한 fallback: 게이트 실패 시 실제 Markdown 보드를 출력한다.
      process.stdout.write(report.markdown);
    } else {
      process.stdout.write(
        `${JSON.stringify(
          {
            selectedSurface: report.selectedSurface,
            outputs: report.outputs,
            reasons: report.reasons,
          },
          null,
          2,
        )}\n`,
      );
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
