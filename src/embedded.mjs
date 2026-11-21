// Embedded mode: the bin runs a project's own config module (policy plus adapters) through the worker's line CLI.
// Used by: src/bin.mjs, when --config names a .mjs or .js file; tested by test/embedded.test.mjs.
// Uses: src/worker.mjs (createConveyor, whose `main` is the line CLI); git, to check the checkout before a real tick.
// Exports: isModuleConfig, configArg, baseArg, checkoutProblem, runEmbedded.
//
// Why a module and not .conveyor.json: a host project passes functions (its approvals, its merge path, its
// window), which JSON can't carry. The module is code from the checkout, and it runs at import, before the
// worker's own clone check. So a real `tick` loads it only from a clean checkout of the named base, at its
// upstream's tip, from a tracked file inside it (`checkoutProblem`): a checkout on a PR branch would otherwise
// run that PR's code with the merge token. Read commands load it as any repo script runs, as the user.
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createConveyor } from "./worker.mjs";

const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

export const isModuleConfig = (path) => typeof path === "string" && /\.(mjs|js)$/u.test(path);

// Splits `--name VALUE` (or `--name=VALUE`) out of argv; returns { value, rest } or null when absent.
const takeOption = (argv, name) => {
  const at = argv.findIndex((arg) => arg === name || arg.startsWith(`${name}=`));
  if (at < 0) return null;
  const spaced = argv[at] === name;
  const value = spaced ? argv[at + 1] : argv[at].slice(name.length + 1);
  return { value, rest: argv.filter((_, index) => index !== at && !(spaced && index === at + 1)) };
};

export const configArg = (argv) => {
  const found = takeOption(argv, "--config");
  return found && { path: found.value, rest: found.rest };
};

export const baseArg = (argv) => takeOption(argv, "--base");

const gitRun = (cwd, args) => {
  const result = spawnSync("git", ["-c", "core.fsmonitor=false", "--no-optional-locks", "-C", cwd, ...args], { encoding: "utf8" });
  return { status: result.status ?? 1, stdout: (result.stdout ?? "").trim() };
};

// Why this checkout may not load `path` for a real tick, or "": a clean checkout of `base`, at its upstream's tip,
// with `path` a tracked file inside it.
export const checkoutProblem = (cwd, path, base, git = gitRun) => {
  if (typeof base !== "string" || base === "") return "a real tick needs --base <branch>, the branch the worker checkout must be on";
  const top = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (top.status !== 0 || !top.stdout) return "not inside a git checkout";
  let file;
  try {
    file = realpathSync(resolve(cwd, path));
  } catch {
    return `${path} does not exist`;
  }
  const inside = relative(realpathSync(top.stdout), file);
  if (inside === "" || inside.startsWith("..") || resolve(inside) === inside) return `${path} is outside the checkout`;
  if (git(top.stdout, ["ls-files", "--error-unmatch", "--", inside]).status !== 0) return `${path} is not a tracked file`;
  // `git status` doesn't see an edit to a file flagged assume-unchanged (tag h) or skip-worktree (S), so such a flag
  // would hide a changed module behind a clean status.
  const tag = git(top.stdout, ["ls-files", "-v", "--", inside]).stdout.slice(0, 1);
  if (tag !== "H") return `${path} is flagged assume-unchanged or skip-worktree`;
  const branch = git(top.stdout, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout;
  if (branch !== base) return `the checkout is on ${branch || "no branch"}, not ${base}`;
  if (git(top.stdout, ["status", "--porcelain"]).stdout) return "the checkout has uncommitted changes";
  const head = git(top.stdout, ["rev-parse", "HEAD"]);
  const upstream = git(top.stdout, ["rev-parse", "@{upstream}"]);
  if (upstream.status !== 0 || !upstream.stdout) return `${base} has no upstream to compare with`;
  return head.stdout === upstream.stdout ? "" : `${base} is not at its upstream's tip`;
};

// Returns the exit code. `status --version` and `--version` print the package version without loading the module.
// Under `status --json` every failure is one `{ ok: false, error }` document.
export const runEmbedded = async (path, argv, { cwd = process.cwd(), out = console.log, err = console.error, load = (url) => import(url), git = gitRun } = {}) => {
  const based = baseArg(argv);
  const args = based ? based.rest : argv;
  if ((args.length === 2 && args[0] === "status" && args[1] === "--version") || (args.length === 1 && args[0] === "--version")) {
    out(VERSION);
    return 0;
  }
  const json = args[0] === "status" && args.includes("--json");
  const fail = (code, message, exit) => {
    if (json) out(JSON.stringify({ ok: false, error: { code, message } }));
    else err(`conveyor: ${message}`);
    return exit;
  };
  const realTick = args.length === 1 && args[0] === "tick";
  if (realTick) {
    const problem = checkoutProblem(cwd, path, based?.value, git);
    if (problem) return fail("untrusted_config", `refusing to load ${path} for a tick: ${problem}`, 2);
  }
  let config;
  try {
    config = (await load(pathToFileURL(resolve(cwd, path)).href)).default;
  } catch (error) {
    return fail("invalid_config", `could not load ${path}: ${error.message}`, 2);
  }
  if (realTick && config?.base !== based.value) return fail("untrusted_config", `${path} names base ${config?.base ?? "none"}, not --base ${based.value}`, 2);
  let conveyor;
  try {
    conveyor = createConveyor(config);
  } catch (error) {
    return fail("invalid_config", `${path}: ${error.message}`, 2);
  }
  if (!json) return conveyor.main(args, { cwd, out, err });
  // Under --json, stdout carries one document: a throw, or a failure that wrote only to stderr (the git dir
  // unreadable, say), becomes the error document instead of a stack trace or an empty stdout.
  const said = [];
  let printed = false;
  try {
    const code = await conveyor.main(args, { cwd, out: (line) => { printed = true; out(line); }, err: (line) => said.push(String(line)) });
    if (code !== 0 && !printed) return fail("status_failed", said.join("\n").replace(/^conveyor: /u, "") || `status exited ${code}`, code);
    for (const line of said) err(line);
    return code;
  } catch (error) {
    return printed ? (err(`conveyor: ${error.message}`), 1) : fail("status_failed", error.message, 1);
  }
};
