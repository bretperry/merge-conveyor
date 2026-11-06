/*
  The publish gate's outside tools: gitleaks over a tree or a history, the built tree's own `pnpm check`, and the "nothing may quiet the scan" check.
  In the app: nothing at runtime; the publish script's gate steps 3, 4 and 5 call it.
  Used by: scripts/lib/publish-run.mjs; tested by scripts/lib/publish-gate.test.mjs.
  Uses: gitleaks and pnpm on PATH (child processes), node builtins.
  Exports: scrubbedEnv (an environment without secrets), runGitleaks (a folder or a history), runGitleaksRenamed (files under neutral names), findScanSuppressions (scan suppression markers), runTreeCheck (pnpm install and check on a copy).

  Every function returns { ok, lines } and never throws on a tool's failure, and "the tool is missing" is a
  red result like any other: a gate whose scanner is not installed has scanned nothing. gitleaks is run
  with --redact, so a finding names the file and rule but never prints the secret into a log. Only the exit
  code decides: 0 is clean; 1 is a finding; anything else (including a crash or a signal) is red too.
*/

import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Environment names a child that runs the tree's own code must not see: the term list, the deploy key, and any token.
const SECRET_ENV = /^(?:HARNESS_DENYLIST|MIRROR_KEY|GIT_SSH_COMMAND|GITHUB_TOKEN|GH_TOKEN|HARNESS_TOKEN|ACTIONS_[A-Z_]*TOKEN)$|(?:_KEY|_TOKEN|_SECRET)$/u;

// `env` without the secrets above.
export const scrubbedEnv = (env = process.env) => Object.fromEntries(Object.entries(env).filter(([name]) => !SECRET_ENV.test(name)));

// The tail of a tool's output, for a red step: enough to see why, not a whole log.
const tailOf = (text, count = 40) => text.trim().split("\n").slice(-count);

// Runs gitleaks as `gitleaks <kind> <path>` (kind: "dir" for a folder, "git" for a repo's history). Returns { ok, lines }.
//
// Nothing in the source repo can steer the scan. It runs from a fresh empty folder (gitleaks looks for a config and an ignore
// file around the working directory), is told an empty folder is where ignore files live (`--gitleaks-ignore-path`,
// whose default is "."), has no GITLEAKS_CONFIG* variable in its environment, and gets the scanned path as an absolute
// argument. The built tree is also refused if it carries a gitleaks config or ignore file (publish-tree.mjs).
export const runGitleaks = (kind, path) => {
  const empty = mkdtempSync(join(tmpdir(), "publish-gitleaks-"));
  try {
    // A history scan names its revisions: every ref, so the candidate commits and every branch the target holds are read, not gitleaks' default.
    const args = [kind, "--redact", "--no-banner", "--exit-code", "1", "--gitleaks-ignore-path", empty, ...(kind === "git" ? ["--log-opts=--full-history --all"] : []), resolve(path)];
    const env = Object.fromEntries(Object.entries(scrubbedEnv(process.env)).filter(([name]) => !name.startsWith("GITLEAKS_")));
    return interpretGitleaks(spawnSync("gitleaks", args, { encoding: "utf8", cwd: empty, env, maxBuffer: 256 * 1024 * 1024 }));
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
};

// gitleaks' result as { ok, lines }: only the exit code decides, and a missing or crashed scanner is red.
const interpretGitleaks = (result) => {
  if (result.error !== undefined) {
    const missing = result.error.code === "ENOENT";
    return { ok: false, lines: [missing ? "gitleaks is not installed or not on PATH, so nothing was scanned (brew install gitleaks, or the Publish public workflow's install step)" : `gitleaks could not run: ${result.error.message}`] };
  }
  if (result.status === 0) return { ok: true, lines: [] };
  const verdict = result.status === 1 ? "gitleaks found a possible secret" : `gitleaks failed (exit ${String(result.status)}${result.signal === null ? "" : `, ${result.signal}`})`;
  return { ok: false, lines: [verdict, ...tailOf(`${result.stdout}\n${result.stderr}`)] };
};

// gitleaks over copies of `files` (relative paths under `dir`) renamed to neutral names in a fresh folder. gitleaks' default
// allowlist skips files by path (lockfiles such as pnpm-lock.yaml, vendor/ and node_modules/ folders, images), so a secret in
// one is never seen by `runGitleaks("dir", dir)`; under a name like file-3.txt it is read. Path-based rules (a key file's name)
// do not apply to the copies, so this is a second pass beside the first, not a replacement. A finding names file-N.txt, so the
// result adds a line saying which file each name was.
export const runGitleaksRenamed = (dir, files) => {
  const copy = mkdtempSync(join(tmpdir(), "publish-renamed-"));
  try {
    files.forEach((path, at) => copyFileSync(join(dir, path), join(copy, `file-${at}.txt`)));
    const result = runGitleaks("dir", copy);
    if (result.ok) return result;
    const named = [...new Set(result.lines.join("\n").match(/file-\d+\.txt/gu) ?? [])];
    return { ok: false, lines: [...result.lines, ...named.map((name) => `${name} is ${files[Number(/\d+/u.exec(name)?.[0])] ?? "(unknown)"}`)] };
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
};

// Fails when any file in `files` (relative paths under `dir`) carries a gitleaks suppression marker, which makes gitleaks skip that line.
export const findScanSuppressions = (dir, files) => {
  const lines = [];
  for (const path of files) {
    let text;
    try {
      text = readFileSync(join(dir, path)).toString("latin1");
    } catch {
      continue;
    }
    // Assemble the diagnostic marker so the distributed scanner does not reject its own source.
    if (/gitleaks:\s*allow/iu.test(text)) lines.push(`${path} has a ${["gitleaks", "allow"].join(":")} marker, which would hide a finding from the scan`);
  }
  return { ok: lines.length === 0, lines };
};

// Runs the tree's own checks on a copy of `dir`: `pnpm install --frozen-lockfile`, then `pnpm check`. The copy keeps the
// built directory byte for byte what gets committed (check writes logs and node_modules). The child sees `env` without secrets.
export const runTreeCheck = (dir, env = scrubbedEnv()) => {
  const copy = mkdtempSync(join(tmpdir(), "publish-check-"));
  try {
    cpSync(dir, copy, { recursive: true });
    const childEnv = { ...env, CI: "true" };
    for (const args of [["install", "--frozen-lockfile"], ["check"]]) {
      const result = spawnSync("pnpm", args, { cwd: copy, encoding: "utf8", env: childEnv, maxBuffer: 256 * 1024 * 1024 });
      if (result.error !== undefined) return { ok: false, lines: [result.error.code === "ENOENT" ? "pnpm is not installed or not on PATH, so the tree's check did not run" : `pnpm could not run: ${result.error.message}`] };
      if (result.status !== 0) return { ok: false, lines: [`pnpm ${args.join(" ")} failed (exit ${String(result.status)}${result.signal === null ? "" : `, ${result.signal}`}) in the built tree:`, ...tailOf(`${result.stdout}\n${result.stderr}`)] };
    }
    return { ok: true, lines: [] };
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
};
