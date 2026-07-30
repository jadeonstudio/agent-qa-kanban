#!/usr/bin/env node

import { appendFile, mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  assertValidHumanLearningEntry,
  parseUntrustedJson,
  readSafeJson,
} from "./board-lib.mjs";

// 검증된 인간 피드백 한 건만 기존 JSONL 뒤에 추가한다.
const logPath = process.argv[2];
const entryPath = process.argv[3];
if (!logPath || !entryPath || process.argv.length > 4) {
  console.error(
    "Usage: record-human-learning.mjs <human-qa-learning.jsonl> <entry.json>",
  );
  process.exitCode = 2;
} else {
  try {
    const resolvedLogPath = resolve(logPath);
    const resolvedEntryPath = resolve(entryPath);
    if (resolvedLogPath === resolvedEntryPath) {
      throw new Error("Learning log and input entry paths must be different");
    }
    const entry = await readSafeJson(resolvedEntryPath, resolvedEntryPath);
    assertValidHumanLearningEntry(entry);

    await mkdir(dirname(resolvedLogPath), { recursive: true });
    const lockPath = `${resolvedLogPath}.lock`;
    const lockHandle = await acquireLogLock(lockPath);
    try {
      const existingLog = await readExistingLog(resolvedLogPath);
      if (existingLog.ids.has(entry.id)) {
        throw new Error(`Human QA learning ID already exists: ${entry.id}`);
      }
      for (const supersededId of entry.supersedes ?? []) {
        if (!existingLog.ids.has(supersededId)) {
          throw new Error(
            `Human QA supersedes reference does not exist: ${supersededId}`,
          );
        }
      }

      const leadingNewline = existingLog.needsLeadingNewline ? "\n" : "";
      await appendFile(
        resolvedLogPath,
        `${leadingNewline}${JSON.stringify(entry)}\n`,
        {
          encoding: "utf8",
          flag: "a",
        },
      );
    } finally {
      await releaseLogLock(lockHandle, lockPath);
    }
    console.log(`Appended human QA learning entry: ${entry.id}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

// 기존 줄을 수정하지 않고 ID 중복과 손상된 JSONL을 먼저 확인한다.
async function readExistingLog(filePath) {
  let text;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return { ids: new Set(), needsLeadingNewline: false };
    }
    throw error;
  }

  const ids = new Set();
  const lines = text.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (line.trim() === "") {
      continue;
    }
    const entry = parseUntrustedJson(
      line,
      `${filePath}:${index + 1}`,
    );
    assertValidHumanLearningEntry(entry);
    if (ids.has(entry.id)) {
      throw new Error(
        `Existing human QA learning log contains duplicate ID: ${entry.id}`,
      );
    }
    for (const supersededId of entry.supersedes ?? []) {
      if (!ids.has(supersededId)) {
        throw new Error(
          `Existing human QA supersedes reference is missing or not older: ${supersededId}`,
        );
      }
    }
    ids.add(entry.id);
  }
  return {
    ids,
    needsLeadingNewline: text.length > 0 && !text.endsWith("\n"),
  };
}

// O_EXCL lock 파일로 중복 검사와 append 사이의 동시 실행 race를 직렬화한다.
async function acquireLogLock(lockPath) {
  try {
    return await open(lockPath, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new Error(
        `Human QA learning log is locked: ${lockPath}. Inspect and remove it only if no recorder is running.`,
      );
    }
    throw error;
  }
}

// 정상·오류 경로 모두에서 현재 프로세스가 만든 lock을 정리한다.
async function releaseLogLock(lockHandle, lockPath) {
  await lockHandle.close();
  try {
    await unlink(lockPath);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}
