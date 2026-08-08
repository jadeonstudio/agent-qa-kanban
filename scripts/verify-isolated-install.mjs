import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = mkdtempSync(resolve(tmpdir(), "agent-qa-kanban-hosts-"));
const keep = process.argv.includes("--keep");

function run(command, args, env) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed\n${result.stdout}${result.stderr}`);
  }
  return result.stdout.trim();
}

function includesPlugin(output, host) {
  let value;
  try {
    value = JSON.parse(output);
  } catch {
    throw new Error(`${host} did not return JSON: ${output}`);
  }
  return JSON.stringify(value).includes("agent-qa-kanban");
}

function findCanonicalSkill(dir, matches = []) {
  if (!existsSync(dir)) return matches;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) findCanonicalSkill(path, matches);
    else if (entry.isFile() && path.split(sep).slice(-3).join("/") === "skills/agent-qa-kanban/SKILL.md") matches.push(path);
  }
  return matches;
}

try {
  const codexHome = resolve(sandbox, "codex-home");
  const claudeHome = resolve(sandbox, "claude-home");
  const grokHome = resolve(sandbox, "grok-home");
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(claudeHome, { recursive: true });
  mkdirSync(grokHome, { recursive: true });

  const codexEnv = { CODEX_HOME: codexHome };
  run("codex", ["plugin", "marketplace", "add", root], codexEnv);
  const codexAvailable = run("codex", ["plugin", "list", "--available", "--json"], codexEnv);
  if (!includesPlugin(codexAvailable, "Codex discovery")) throw new Error("Codex did not discover agent-qa-kanban");
  run("codex", ["plugin", "add", "agent-qa-kanban@agent-qa-kanban"], codexEnv);
  const codexInstalled = run("codex", ["plugin", "list", "--json"], codexEnv);
  if (!includesPlugin(codexInstalled, "Codex install")) throw new Error("Codex did not list the installed plugin");
  if (findCanonicalSkill(codexHome).length !== 1) throw new Error("Codex cache did not contain exactly one canonical skill");

  const claudeEnv = { CLAUDE_CONFIG_DIR: claudeHome };
  run("claude", ["plugin", "marketplace", "add", root], claudeEnv);
  const claudeAvailable = run("claude", ["plugin", "list", "--available", "--json"], claudeEnv);
  if (!includesPlugin(claudeAvailable, "Claude discovery")) throw new Error("Claude did not discover agent-qa-kanban");
  run("claude", ["plugin", "install", "agent-qa-kanban@agent-qa-kanban", "--scope", "user"], claudeEnv);
  const claudeInstalled = run("claude", ["plugin", "list", "--json"], claudeEnv);
  if (!includesPlugin(claudeInstalled, "Claude install")) throw new Error("Claude did not list the installed plugin");
  const claudeDetails = run("claude", ["plugin", "details", "agent-qa-kanban@agent-qa-kanban"], claudeEnv);
  if (!/Skills \(1\)\s+agent-qa-kanban/.test(claudeDetails)) throw new Error("Claude did not discover the canonical skill");
  if (findCanonicalSkill(claudeHome).length !== 1) throw new Error("Claude cache did not contain exactly one canonical skill");

  const grokEnv = { GROK_HOME: grokHome };
  run("grok", ["plugin", "install", root, "--trust"], grokEnv);
  const grokInstalled = run("grok", ["plugin", "list", "--json"], grokEnv);
  if (!includesPlugin(grokInstalled, "Grok install")) throw new Error("Grok did not list the installed plugin");
  const grokDetails = run("grok", ["plugin", "details", "agent-qa-kanban"], grokEnv);
  if (!/components: 1 skill dir\(s\)/.test(grokDetails)) throw new Error("Grok did not discover the canonical skill");
  if (findCanonicalSkill(grokHome).length !== 1) throw new Error("Grok cache did not contain exactly one canonical skill");

  console.log("Isolated Codex install and skill discovery passed.");
  console.log("Isolated Claude install and skill discovery passed.");
  console.log("Isolated Grok install and skill discovery passed.");
  console.log("Installation produced only isolated host configuration/cache state; no target project or runtime qa-board was initialized.");
} finally {
  if (keep) console.log(`Kept isolated host state at ${sandbox}`);
  else rmSync(sandbox, { recursive: true, force: true });
}
