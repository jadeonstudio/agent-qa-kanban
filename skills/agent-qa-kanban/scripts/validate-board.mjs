#!/usr/bin/env node

import { resolve } from "node:path";
import { assertValidBoard, readSafeJson } from "./board-lib.mjs";

// CLI 입력 경로를 명시적으로 받아 임의 기본 파일 검증을 피한다.
const inputPath = process.argv[2];
if (!inputPath || process.argv.length > 3) {
  console.error("Usage: validate-board.mjs <board.json>");
  process.exitCode = 2;
} else {
  try {
    const resolvedPath = resolve(inputPath);
    const board = await readSafeJson(resolvedPath, resolvedPath);
    assertValidBoard(board);
    console.log(
      `Valid QA board: ${board.board.id} (${board.cards.length} card${
        board.cards.length === 1 ? "" : "s"
      })`,
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
