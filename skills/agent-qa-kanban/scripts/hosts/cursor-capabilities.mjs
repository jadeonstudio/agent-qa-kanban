#!/usr/bin/env node

import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";

// Cursor Canvas 칸반을 켤지 말지 결정하는 읽기 전용 capability probe다.
export const CURSOR_SURFACES = Object.freeze({
  CURSOR_CANVAS: "cursor-canvas",
  MARKDOWN_FALLBACK: "markdown-fallback",
});

const SKILL_NAME = "agent-qa-kanban";
const CANVAS_SKILL_RELATIVE = join(
  ".cursor",
  "skills-cursor",
  "canvas",
  "SKILL.md",
);

// 홈·cwd·env를 주입해 테스트에서 실제 Cursor 설치와 분리한다.
export function createProbeContext(options = {}) {
  return {
    homeDir: options.homeDir ?? homedir(),
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
    pathExists: options.pathExists ?? existsSync,
    realpath: options.realpath ?? safeRealpath,
  };
}

// Cursor docs의 project/user skill root를 모두 탐색한다.
export function listCursorSkillCandidates(context) {
  const { homeDir, cwd } = context;
  return [
    join(cwd, ".cursor", "skills", SKILL_NAME),
    join(cwd, ".agents", "skills", SKILL_NAME),
    join(homeDir, ".cursor", "skills", SKILL_NAME),
    join(homeDir, ".agents", "skills", SKILL_NAME),
  ];
}

// Cursor skill root에 SKILL.md가 있으면 설치됨으로 본다 (symlink 허용).
export function detectCursorSkillInstall(options = {}) {
  const context = createProbeContext(options);
  const candidates = listCursorSkillCandidates(context);
  for (const root of candidates) {
    const skillMd = join(root, "SKILL.md");
    if (context.pathExists(skillMd)) {
      return {
        installed: true,
        root,
        skillMd,
        viaSymlink: isSymlinkPath(root, context),
      };
    }
  }
  return {
    installed: false,
    root: null,
    skillMd: null,
    viaSymlink: false,
    checked: candidates,
  };
}

// Cursor IDE/Agent의 built-in Canvas skill 존재 여부로 호스트 능력을 판별한다.
export function detectCanvasHost(options = {}) {
  const context = createProbeContext(options);
  const skillMd = join(context.homeDir, CANVAS_SKILL_RELATIVE);
  const available = context.pathExists(skillMd);
  return {
    available,
    skillMd: available ? skillMd : null,
    reason: available
      ? "Cursor built-in canvas skill is present"
      : "Cursor built-in canvas skill was not found",
  };
}

// 디스크에 Cursor가 있어도, 지금 프로세스가 Cursor 세션인지 확인한다.
export function detectCursorRuntimeSession(options = {}) {
  const context = createProbeContext(options);
  const env = context.env ?? {};
  const signals = [];
  if (isTruthyEnv(env.CURSOR_AGENT)) {
    signals.push("CURSOR_AGENT");
  }
  if (isTruthyEnv(env.CURSOR_CONVERSATION_ID)) {
    signals.push("CURSOR_CONVERSATION_ID");
  }
  // Cursor Agent CLI로 직접 실행 중인 경우 argv0/execPath도 보조 신호로 쓴다.
  const execPath = String(env.CURSOR_PROBE_EXEC_PATH || process.execPath || "");
  if (/cursor-agent/i.test(execPath)) {
    signals.push("execPath:cursor-agent");
  }
  const active = signals.length > 0;
  return {
    active,
    signals,
    reason: active
      ? `Cursor runtime session detected via ${signals.join(", ")}`
      : "No Cursor runtime session signals (CURSOR_AGENT / CURSOR_CONVERSATION_ID)",
  };
}

// PATH의 임의 agent를 Cursor로 오인하지 않도록 cursor-agent만 검증한다.
export function detectCursorAgentCli(options = {}) {
  const context = createProbeContext(options);
  const pathEntries = String(context.env.PATH || "")
    .split(delimiter)
    .filter(Boolean);
  for (const entry of pathEntries) {
    const binary = join(entry, "cursor-agent");
    if (!context.pathExists(binary)) {
      continue;
    }
    const resolved = context.realpath(binary);
    if (!resolved) {
      continue;
    }
    const looksLikeCursor =
      /(^|[\\/])cursor-agent$/i.test(resolved) || /cursor/i.test(resolved);
    if (!looksLikeCursor) {
      continue;
    }
    return {
      present: true,
      binary: resolved,
      trusted: true,
    };
  }
  return {
    present: false,
    binary: null,
    trusted: false,
    note: "Unverified PATH `agent` binaries are ignored to avoid Grok/other agent confusion",
  };
}

// 설치·Canvas 능력·런타임 세션을 묶고 선택 surface를 결정한다.
export function probeCursorCapabilities(options = {}) {
  const context = createProbeContext(options);
  const skill = detectCursorSkillInstall(context);
  const canvasHost = detectCanvasHost(context);
  const runtime = detectCursorRuntimeSession(context);
  const agentCli = detectCursorAgentCli(context);
  const gate = {
    cursorSkillInstalled: skill.installed,
    canvasHostAvailable: canvasHost.available,
    cursorRuntimeActive: runtime.active,
    allowed:
      skill.installed && canvasHost.available && runtime.active,
  };
  const selectedSurface = gate.allowed
    ? CURSOR_SURFACES.CURSOR_CANVAS
    : CURSOR_SURFACES.MARKDOWN_FALLBACK;

  return {
    probedAt: new Date().toISOString(),
    skill,
    canvasHost,
    runtime,
    agentCli,
    gate,
    selectedSurface,
    reasons: buildGateReasons(gate, skill, canvasHost, runtime),
  };
}

function buildGateReasons(gate, skill, canvasHost, runtime) {
  const reasons = [];
  if (!gate.cursorSkillInstalled) {
    reasons.push(
      "agent-qa-kanban is not installed under a Cursor/.agents skill path",
    );
  } else {
    reasons.push(`Cursor skill install found at ${skill.root}`);
  }
  if (!gate.canvasHostAvailable) {
    reasons.push(canvasHost.reason);
  } else {
    reasons.push(canvasHost.reason);
  }
  if (!gate.cursorRuntimeActive) {
    reasons.push(runtime.reason);
  } else {
    reasons.push(runtime.reason);
  }
  if (gate.allowed) {
    reasons.push("Gate passed: render Cursor Canvas board");
  } else {
    reasons.push(
      "Gate failed: use Markdown fallback and do not claim a canvas board",
    );
  }
  return reasons;
}

function isTruthyEnv(value) {
  if (value === undefined || value === null) {
    return false;
  }
  const normalized = String(value).trim().toLowerCase();
  return normalized !== "" && normalized !== "0" && normalized !== "false";
}

function isSymlinkPath(path, context) {
  try {
    const resolved = context.realpath(path);
    return Boolean(resolved && resolved !== path);
  } catch {
    return false;
  }
}

function safeRealpath(path) {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

const isMain =
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(resolvePath(process.argv[1])).href;
if (isMain) {
  const report = probeCursorCapabilities();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
