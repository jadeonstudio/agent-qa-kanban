#!/usr/bin/env node

import { resolve } from "node:path";
import {
  assertValidHumanLearningEntry,
  readSafeJson,
} from "./board-lib.mjs";

// 학습 로그에 쓰기 전에 단일 인간 피드백 항목을 read-only로 검증한다.
const inputPath = process.argv[2];
if (!inputPath || process.argv.length > 3) {
  console.error("Usage: validate-human-learning.mjs <entry.json>");
  process.exitCode = 2;
} else {
  try {
    const resolvedPath = resolve(inputPath);
    const entry = await readSafeJson(resolvedPath, resolvedPath);
    assertValidHumanLearningEntry(entry);
    console.log(`Valid human QA learning entry: ${entry.id}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
