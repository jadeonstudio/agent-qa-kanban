import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_NAME = "agent-qa-kanban";
const REQUIRED_INTERFACE_FIELDS = [
  "displayName",
  "shortDescription",
  "longDescription",
  "developerName",
  "category",
  "capabilities",
  "defaultPrompt"
];

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function assert(condition, message, errors) {
  if (!condition) errors.push(message);
}

function walk(dir, result = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if ([".git", ".tmp", "node_modules"].includes(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, result);
    else if (entry.isFile()) result.push(path);
  }
  return result;
}

function sourceRoot(root, sourcePath) {
  return realpathSync(resolve(root, sourcePath));
}

export function validatePluginPackaging(rootDir) {
  const root = realpathSync(rootDir);
  const paths = {
    package: join(root, "package.json"),
    codex: join(root, ".codex-plugin", "plugin.json"),
    codexMarketplace: join(root, ".agents", "plugins", "marketplace.json"),
    claude: join(root, ".claude-plugin", "plugin.json"),
    claudeMarketplace: join(root, ".claude-plugin", "marketplace.json"),
    skill: join(root, "skills", PLUGIN_NAME, "SKILL.md")
  };
  const errors = [];

  for (const [label, path] of Object.entries(paths)) {
    assert(existsSync(path), `${label} is missing: ${relative(root, path)}`, errors);
  }
  if (errors.length) return { ok: false, errors };

  const pkg = readJson(paths.package);
  const codex = readJson(paths.codex);
  const codexMarketplace = readJson(paths.codexMarketplace);
  const claude = readJson(paths.claude);
  const claudeMarketplace = readJson(paths.claudeMarketplace);
  const versionEntries = [
    ["package.json", pkg.version],
    ["Codex manifest", codex.version],
    ["Claude manifest", claude.version],
    ["Claude marketplace", claudeMarketplace.plugins?.[0]?.version]
  ];

  for (const [label, value] of versionEntries) {
    assert(value === pkg.version, `${label} version must equal package.json (${pkg.version})`, errors);
  }
  assert(pkg.name === PLUGIN_NAME, `package name must be ${PLUGIN_NAME}`, errors);
  assert(codex.name === PLUGIN_NAME, `Codex manifest name must be ${PLUGIN_NAME}`, errors);
  assert(claude.name === PLUGIN_NAME, `Claude manifest name must be ${PLUGIN_NAME}`, errors);
  assert(codex.skills === "./skills/", "Codex manifest must use the canonical ./skills/ tree", errors);

  for (const field of REQUIRED_INTERFACE_FIELDS) {
    const value = codex.interface?.[field];
    assert(Array.isArray(value) ? value.length > 0 : typeof value === "string" && value.length > 0,
      `Codex interface.${field} is required`, errors);
  }
  assert(codex.interface?.defaultPrompt?.length <= 3, "Codex interface.defaultPrompt supports at most 3 prompts", errors);
  for (const prompt of codex.interface?.defaultPrompt ?? []) {
    assert(prompt.length <= 128, "Each Codex default prompt must be 128 characters or shorter", errors);
    assert(prompt.includes("$agent-qa-kanban"), "Each Codex default prompt must explicitly invoke $agent-qa-kanban", errors);
  }
  const visualPrompts = (codex.interface?.defaultPrompt ?? []).filter((prompt) => /visual-browser/i.test(prompt));
  assert(visualPrompts.length === 1 && /explicit/i.test(visualPrompts[0]),
    "Exactly one default prompt may request visual-browser QA, and it must say it is explicit", errors);

  for (const forbidden of ["hooks", "mcpServers", "apps", "commands"]) {
    assert(!(forbidden in codex), `Codex manifest must not declare ${forbidden}; install must remain inert`, errors);
    assert(!(forbidden in claude), `Claude manifest must not declare ${forbidden}; install must remain inert`, errors);
  }

  const codexEntry = codexMarketplace.plugins?.find((entry) => entry.name === PLUGIN_NAME);
  assert(Boolean(codexEntry), "Codex marketplace must expose agent-qa-kanban", errors);
  assert(codexEntry?.source?.source === "local", "Codex marketplace source must be local", errors);
  assert(codexEntry?.policy?.installation === "AVAILABLE", "Codex plugin must be available, not installed by default", errors);
  assert(codexEntry?.policy?.authentication === "ON_USE", "Codex plugin authentication policy must be ON_USE", errors);

  const claudeEntry = claudeMarketplace.plugins?.find((entry) => entry.name === PLUGIN_NAME);
  assert(Boolean(claudeEntry), "Claude marketplace must expose agent-qa-kanban", errors);

  try {
    assert(sourceRoot(root, codexEntry.source.path) === root,
      "Codex marketplace must resolve to the repository root", errors);
  } catch (error) {
    errors.push(`Codex marketplace source is invalid: ${error.message}`);
  }
  try {
    assert(sourceRoot(root, claudeEntry.source) === root,
      "Claude marketplace must resolve to the repository root", errors);
  } catch (error) {
    errors.push(`Claude marketplace source is invalid: ${error.message}`);
  }

  const skillFiles = walk(root).filter((path) => path.endsWith(`${sep}${PLUGIN_NAME}${sep}SKILL.md`));
  assert(skillFiles.length === 1, `Expected one canonical ${PLUGIN_NAME}/SKILL.md, found ${skillFiles.length}`, errors);
  assert(skillFiles[0] === paths.skill, "Plugin and direct Agent Skills installs must share skills/agent-qa-kanban", errors);

  const skillText = readFileSync(paths.skill, "utf8");
  assert(/visual\/browser execution profile is opt-in only/i.test(skillText),
    "Canonical skill must state that the visual/browser profile is opt-in only", errors);
  assert(/explicit user request/i.test(skillText),
    "Canonical skill must require an explicit user request for visual/browser execution", errors);

  return {
    ok: errors.length === 0,
    errors,
    facts: {
      plugin: PLUGIN_NAME,
      version: pkg.version,
      canonicalSkill: relative(root, paths.skill),
      codexSource: relative(root, sourceRoot(root, codexEntry.source.path)) || ".",
      claudeSource: relative(root, sourceRoot(root, claudeEntry.source)) || ".",
      grokCompatibility: "Claude plugin and marketplace layout",
      installationSideEffects: "none declared"
    }
  };
}

function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = resolve(here, "..");
  const result = validatePluginPackaging(root);
  if (process.argv.includes("--json")) console.log(JSON.stringify(result, null, 2));
  else if (result.ok) {
    console.log(`Plugin packaging valid: ${result.facts.plugin}@${result.facts.version}`);
    console.log(`Canonical skill: ${result.facts.canonicalSkill}`);
    console.log("Codex, Claude, and Grok-compatible layouts resolve to the same plugin root.");
  } else {
    for (const error of result.errors) console.error(`- ${error}`);
  }
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();
