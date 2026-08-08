import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validatePluginPackaging } from "../scripts/plugin-contract.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("Codex, Claude, and Grok-compatible packaging shares one canonical skill", () => {
  const result = validatePluginPackaging(root);
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
  assert.equal(result.facts.canonicalSkill, "skills/agent-qa-kanban/SKILL.md");
  assert.equal(result.facts.codexSource, ".");
  assert.equal(result.facts.claudeSource, ".");
  assert.equal(result.facts.grokCompatibility, "Claude plugin and marketplace layout");
});

test("plugin install declarations are inert and visual QA is explicitly opt-in", () => {
  const codex = JSON.parse(readFileSync(resolve(root, ".codex-plugin/plugin.json"), "utf8"));
  const claude = JSON.parse(readFileSync(resolve(root, ".claude-plugin/plugin.json"), "utf8"));
  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  const serialized = JSON.stringify({ codex, claude });

  for (const key of ["hooks", "mcpServers", "apps", "commands"]) {
    assert.equal(key in codex, false);
    assert.equal(key in claude, false);
  }
  assert.doesNotMatch(serialized, /mkdir|init_run|postinstall/i);
  assert.equal("postinstall" in pkg.scripts, false);
  assert.equal(codex.interface.defaultPrompt.filter((prompt) => /visual-browser/i.test(prompt)).length, 1);
  assert.match(codex.interface.defaultPrompt.at(-1), /explicitly requested/i);
});
