import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validatePluginPackaging } from "./plugin-contract.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const requireTag = process.argv.includes("--require-tag");
const requireMain = requireTag || process.argv.includes("--require-main");
const errors = [];

const packaging = validatePluginPackaging(root);
errors.push(...packaging.errors);

function git(...args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "";
}

const head = git("rev-parse", "HEAD");
const main = git("rev-parse", "refs/remotes/origin/main");
const exactTag = git("describe", "--tags", "--exact-match", "HEAD");
const expectedTag = `v${pkg.version}`;

if (!head) errors.push("Cannot resolve HEAD");
if (requireMain && !main) errors.push("Cannot resolve origin/main; fetch the remote before the release gate");
else if (requireMain && head !== main) errors.push("HEAD must equal origin/main for release");

if (exactTag && exactTag !== expectedTag) {
  errors.push(`HEAD tag ${exactTag} must equal ${expectedTag}`);
} else if (requireTag && exactTag !== expectedTag) {
  errors.push(`HEAD must have exact release tag ${expectedTag}`);
}

if (errors.length) {
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log(`Version alignment valid: package and host manifests are ${pkg.version}.`);
  if (head === main) console.log(`Main alignment valid: HEAD equals origin/main (${head.slice(0, 12)}).`);
  else if (requireMain) console.log("Main alignment required for this release run.");
  else console.log("Main alignment not enforced for this branch/PR run; use --require-main or --require-tag.");
  if (exactTag) console.log(`Release tag valid: ${exactTag}.`);
  else console.log(`Release tag pending: expected ${expectedTag}; rerun with --require-tag in tag CI.`);
}
