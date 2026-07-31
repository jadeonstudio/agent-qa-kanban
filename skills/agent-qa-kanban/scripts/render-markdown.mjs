#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  assertValidBoard,
  readSafeJson,
} from "./board-lib.mjs";
import { renderMarkdownBoard } from "./render-markdown-lib.mjs";

// HTML을 지원하지 않는 호스트를 위한 완전한 Markdown 출력 경로다.
const inputPath = process.argv[2];
const outputPath = process.argv[3];
if (!inputPath || !outputPath || process.argv.length > 4) {
  console.error("Usage: render-markdown.mjs <board.json> <output.md>");
  process.exitCode = 2;
} else {
  try {
    const resolvedInputPath = resolve(inputPath);
    const resolvedOutputPath = resolve(outputPath);
    if (resolvedInputPath === resolvedOutputPath) {
      throw new Error("Input board and Markdown output paths must be different");
    }
    const board = await readSafeJson(resolvedInputPath, resolvedInputPath);
    assertValidBoard(board);
    const markdown = renderMarkdownBoard(board);
    await mkdir(dirname(resolvedOutputPath), { recursive: true });
    await writeFile(resolvedOutputPath, markdown, "utf8");
    console.log(`Rendered Markdown QA board: ${resolvedOutputPath}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
