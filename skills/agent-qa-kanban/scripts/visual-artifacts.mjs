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
import { mkdir } from "node:fs/promises";
import { basename, dirname, join, posix, resolve, win32 } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertValidBoard,
  isVisualBrowserProfile,
  readSafeJson,
} from "./board-lib.mjs";
import { escapeMarkdown } from "./render-markdown-lib.mjs";

const VISUAL_DIRECTORIES = ["screenshots", "evidence"];

// Board ref와 동일한 portable slash 형식으로 visual/ 하위 상대경로를 검증한다.
export function normalizeVisualArtifactPath(relativePath) {
  if (typeof relativePath !== "string" || relativePath.length === 0) {
    throw new Error("Visual artifact path must be a non-empty relative path");
  }
  if (/\0|[\u0001-\u001f\u007f]/.test(relativePath)) {
    throw new Error("Visual artifact path must not contain control characters");
  }
  if (posix.isAbsolute(relativePath) || win32.isAbsolute(relativePath)) {
    throw new Error("Visual artifact path must be relative to visual/");
  }

  const portable = relativePath.replaceAll("\\", "/");
  const segments = portable.split("/");
  if (
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  ) {
    throw new Error("Visual artifact path traversal is not allowed");
  }
  if (
    segments.some(
      (segment) =>
        segment.includes(":") ||
        /[. ]$/.test(segment) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(segment),
    )
  ) {
    throw new Error("Visual artifact path is not portable across supported platforms");
  }
  const normalized = posix.normalize(portable);
  if (normalized === "qa-board.json" || normalized.startsWith("../")) {
    throw new Error("Visual artifact path must not collide with qa-board.json");
  }
  return normalized;
}

export function resolveVisualArtifactPath(boardPath, relativePath) {
  const canonicalBoard = realpathSync(resolve(boardPath));
  const runDirectory = dirname(canonicalBoard);
  const visualRoot = join(runDirectory, "visual");
  const normalized = normalizeVisualArtifactPath(relativePath);
  const targetPath = join(visualRoot, ...normalized.split("/"));
  const relativeToRoot = posix.relative(
    visualRoot.replaceAll("\\", "/"),
    targetPath.replaceAll("\\", "/"),
  );
  if (relativeToRoot.startsWith("../") || relativeToRoot === "..") {
    throw new Error("Visual artifact path escapes the visual/ directory");
  }
  return { canonicalBoard, runDirectory, visualRoot, targetPath, normalized };
}

export async function prepareVisualArtifacts({ boardPath, board = null }) {
  const resolvedBoardPath = resolve(boardPath);
  const boardDocument = board ?? (await readSafeJson(resolvedBoardPath));
  assertValidBoard(boardDocument);
  if (!isVisualBrowserProfile(boardDocument)) {
    throw new Error(
      "Visual artifacts require an explicit visual-browser execution profile",
    );
  }
  if (boardDocument.board.mode === "plan-only") {
    throw new Error("plan-only mode does not authorize derived artifact writes");
  }

  const { canonicalBoard, visualRoot } = resolveVisualArtifactPath(
    resolvedBoardPath,
    "summary.md",
  );
  await ensureDirectoryNoSymlink(visualRoot);
  for (const child of VISUAL_DIRECTORIES) {
    await ensureDirectoryNoSymlink(join(visualRoot, child));
  }

  const summary = renderVisualSummary(boardDocument);
  const summaryPath = await writeVisualArtifact({
    boardPath: canonicalBoard,
    relativePath: "summary.md",
    content: summary,
  });
  return {
    visualRoot,
    summaryPath,
    screenshotDirectory: join(visualRoot, "screenshots"),
    evidenceDirectory: join(visualRoot, "evidence"),
  };
}

export async function writeVisualArtifact({
  boardPath,
  relativePath,
  content,
}) {
  const boardDocument = await readSafeJson(resolve(boardPath));
  assertValidBoard(boardDocument);
  if (!isVisualBrowserProfile(boardDocument)) {
    throw new Error(
      "Visual artifacts require an explicit visual-browser execution profile",
    );
  }
  if (boardDocument.board.mode === "plan-only") {
    throw new Error("plan-only mode does not authorize derived artifact writes");
  }
  const paths = resolveVisualArtifactPath(boardPath, relativePath);
  if (
    paths.normalized !== "summary.md" &&
    boardDocument.board.execution_profile.browser_capability.status !==
      "available"
  ) {
    throw new Error(
      "Browser evidence writes require available browser capability",
    );
  }
  await ensureDirectoryNoSymlink(paths.visualRoot);
  await ensureSafeParentDirectories(paths.visualRoot, dirname(paths.targetPath));
  assertSafeArtifactTarget(paths.canonicalBoard, paths.targetPath);
  writeAtomicNoFollow(paths.targetPath, content);
  return paths.targetPath;
}

export function renderVisualSummary(boardDocument) {
  assertValidBoard(boardDocument);
  if (!isVisualBrowserProfile(boardDocument)) {
    throw new Error("Cannot render a visual summary for a non-visual board");
  }
  const profile = boardDocument.board.execution_profile;
  const capability = profile.browser_capability;
  const browserCards = boardDocument.cards.filter((card) =>
    card.verification.checks.some((check) => check.type === "browser"),
  );
  const visualDone = browserCards.filter((card) => card.status === "done").length;
  const visualBlocked = browserCards.filter(
    (card) => card.status === "blocked",
  ).length;
  const lines = [
    "# Visual/browser QA summary",
    "",
    "Derived from `qa-board.json`; this file is not canonical.",
    "",
    `- Profile: ${escapeMarkdown(profile.name)}`,
    `- Activation: ${escapeMarkdown(profile.activation)}`,
    `- Mode: ${escapeMarkdown(boardDocument.board.mode)}`,
    `- Lane: ${escapeMarkdown(boardDocument.board.lane)}`,
    `- Browser capability: ${escapeMarkdown(capability.status)}`,
    `- Host: ${escapeMarkdown(capability.host)}`,
    `- Probe: ${escapeMarkdown(capability.probe_method)}`,
    `- Cards: ${browserCards.length}`,
    `- Done: ${visualDone}`,
    `- Blocked: ${visualBlocked}`,
    "",
    "## Scenarios and findings",
    "",
  ];
  for (const card of browserCards) {
    lines.push(
      `- **${escapeMarkdown(card.id)}** ${escapeMarkdown(card.title)} — ${escapeMarkdown(card.status)} / ${escapeMarkdown(card.resolution)}`,
    );
    for (const evidence of card.evidence) {
      const ref = evidence.ref ? ` (${escapeMarkdown(evidence.ref)})` : "";
      lines.push(
        `  - ${escapeMarkdown(evidence.type)}: ${escapeMarkdown(evidence.summary)}${ref}`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

async function ensureSafeParentDirectories(root, targetDirectory) {
  const relative = posix.relative(
    root.replaceAll("\\", "/"),
    targetDirectory.replaceAll("\\", "/"),
  );
  if (relative === "") {
    return;
  }
  if (relative === ".." || relative.startsWith("../")) {
    throw new Error("Visual artifact parent escapes the visual/ directory");
  }
  let current = root;
  for (const segment of relative.split("/")) {
    current = join(current, segment);
    await ensureDirectoryNoSymlink(current);
  }
}

async function ensureDirectoryNoSymlink(directoryPath) {
  const resolvedDirectory = resolve(directoryPath);
  try {
    const current = lstatSync(resolvedDirectory);
    if (current.isSymbolicLink()) {
      throw new Error(`Refusing visual artifact symlink directory: ${resolvedDirectory}`);
    }
    if (!current.isDirectory()) {
      throw new Error(`Visual artifact parent is not a directory: ${resolvedDirectory}`);
    }
    return;
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
  await mkdir(resolvedDirectory);
}

function assertSafeArtifactTarget(canonicalBoard, targetPath) {
  const resolvedTarget = resolve(targetPath);
  if (resolvedTarget === canonicalBoard) {
    throw new Error("Refusing to overwrite canonical qa-board.json");
  }
  if (!existsSync(resolvedTarget)) {
    return;
  }
  const targetLink = lstatSync(resolvedTarget);
  if (targetLink.isSymbolicLink()) {
    throw new Error(`Refusing to write through symlink: ${resolvedTarget}`);
  }
  const target = statSync(resolvedTarget);
  const board = statSync(canonicalBoard);
  if (target.dev === board.dev && target.ino === board.ino) {
    throw new Error("Refusing visual artifact hardlink to canonical qa-board.json");
  }
  if (target.nlink > 1) {
    throw new Error("Refusing to overwrite a hardlinked visual artifact");
  }
  if (!target.isFile()) {
    throw new Error(`Visual artifact target is not a regular file: ${resolvedTarget}`);
  }
}

function writeAtomicNoFollow(targetPath, content) {
  const tempPath = join(
    dirname(targetPath),
    `.${basename(targetPath)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  let flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL;
  if (fsConstants.O_NOFOLLOW) {
    flags |= fsConstants.O_NOFOLLOW;
  }
  let fd = null;
  try {
    fd = openSync(tempPath, flags, 0o644);
    const buffer = Buffer.isBuffer(content)
      ? content
      : Buffer.from(String(content), "utf8");
    writeSync(fd, buffer);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tempPath, targetPath);
  } catch (error) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Preserve the original write error.
      }
    }
    try {
      unlinkSync(tempPath);
    } catch {
      // Preserve the original write error.
    }
    throw error;
  }
}

const isMain =
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  const boardPath = process.argv[2];
  if (!boardPath || process.argv.length !== 3) {
    console.error("Usage: visual-artifacts.mjs <qa-board.json>");
    process.exitCode = 2;
  } else {
    try {
      const result = await prepareVisualArtifacts({ boardPath });
      process.stdout.write(
        `${JSON.stringify(
          {
            visualRoot: result.visualRoot,
            summaryPath: result.summaryPath,
          },
          null,
          2,
        )}\n`,
      );
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
