// Embedded mode and approval-log aliases: the pieces a host project with its own adapters needs.
// Used by: node:test.
// Run: node --test test/embedded.test.mjs.
// When: changing src/embedded.mjs, src/bin.mjs, or the approvals log names.
// Env: none.
// Writes: temp dirs only.
// Exit: 0 pass, 1 a case failed.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { createApprovals } from "../src/approvals.mjs";
import { checkoutProblem, configArg, isModuleConfig, runEmbedded } from "../src/embedded.mjs";

const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

test("--config is split out of argv in both spellings", () => {
  assert.deepEqual(configArg(["--config", "a.mjs", "tick", "--dry-run"]), { path: "a.mjs", rest: ["tick", "--dry-run"] });
  assert.deepEqual(configArg(["status", "--config=b.mjs"]), { path: "b.mjs", rest: ["status"] });
  assert.equal(configArg(["status"]), null);
  assert.equal(isModuleConfig("scripts/conveyor.config.mjs"), true);
  assert.equal(isModuleConfig(".conveyor.json"), false);
});

test("status --version prints the package version without loading the config", async () => {
  const lines = [];
  const code = await runEmbedded("missing.mjs", ["status", "--version"], { out: (line) => lines.push(line), load: () => assert.fail("loaded") });
  assert.equal(code, 0);
  assert.deepEqual(lines, [VERSION]);
});

test("a config that fails to load or validate is a usage error, never a tick", async () => {
  const errors = [];
  const err = (line) => errors.push(line);
  assert.equal(await runEmbedded("x.mjs", ["tick", "--dry-run"], { err, load: async () => { throw new Error("boom"); } }), 2);
  assert.equal(await runEmbedded("x.mjs", ["tick", "--dry-run"], { err, load: async () => ({ default: { base: "dev" } }) }), 2);
  assert.match(errors.join("\n"), /boom/);
  assert.match(errors.join("\n"), /baseWorkflow/);
});

test("a yes recorded under an older approvals log name still counts; writes keep the current name", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "conveyor-approvals-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const make = (aliases) => createApprovals({ HOLD_PATTERNS: [[/^migrations\//, "migrations"]], MAX_PR_FILES: 100, heldBy: () => [], pathsHeld: () => [], approvalsLog: "new-approvals.log", approvalsLogAliases: aliases });
  const now = new Date("2026-01-01T12:00:00.000Z");
  const record = { pr: 1, scope: "hold:migrations", expires: "2026-01-01T13:00:00.000Z" };
  writeFileSync(join(dir, "old-approvals.log"), `${JSON.stringify(record)}\n`);
  assert.equal(make([]).activeApprovals(dir, now).length, 0);
  const approvals = make(["old-approvals.log"]);
  assert.equal(approvals.APPROVALS_LOG, "new-approvals.log");
  assert.deepEqual(approvals.activeApprovals(dir, now), [record]);
  for (const bad of ["old.log", [""], ["a/b.log"], [3], ["."], [".."]]) assert.throws(() => make(bad), /approvalsLogAliases/);
});

test("--version beside --config prints the version, and so does the bin", async () => {
  const lines = [];
  assert.equal(await runEmbedded("x.mjs", ["--version"], { out: (line) => lines.push(line), load: () => assert.fail("loaded") }), 0);
  assert.deepEqual(lines, [VERSION]);
  const bin = fileURLToPath(new URL("../src/bin.mjs", import.meta.url));
  const routed = spawnSync(process.execPath, [bin, "--config", "missing.mjs", "--version"], { encoding: "utf8" });
  assert.equal(routed.status, 0);
  assert.equal(routed.stdout.trim(), VERSION);
  const plain = spawnSync(process.execPath, [bin, "--help"], { encoding: "utf8" });
  assert.equal(plain.status, 0);
  assert.match(plain.stdout, /Configuration: \.conveyor\.json/);
});

test("status --json reports a module that fails to load or validate as one error document", async () => {
  for (const load of [async () => { throw new Error("boom"); }, async () => ({ default: { base: "dev" } })]) {
    const lines = [];
    assert.equal(await runEmbedded("x.mjs", ["status", "--json"], { out: (line) => lines.push(line), err: () => assert.fail("stderr"), load }), 2);
    assert.equal(lines.length, 1);
    const doc = JSON.parse(lines[0]);
    assert.equal(doc.ok, false);
    assert.equal(doc.error.code, "invalid_config");
  }
});

// A fake git: `answers` maps a git subcommand to its { status, stdout }.
const fakeGit = (answers) => (_cwd, args) => answers[args[0] === "rev-parse" ? `rev-parse ${args[1]}` : args[0]] ?? { status: 0, stdout: "" };

test("a real tick loads the module only from a clean checkout of --base at its upstream's tip", async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "conveyor-embedded-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "conveyor.config.mjs"), "export default {};\n");
  const good = { "rev-parse --show-toplevel": { status: 0, stdout: dir }, "ls-files": { status: 0, stdout: "H conveyor.config.mjs" }, "rev-parse --abbrev-ref": { status: 0, stdout: "dev" }, status: { status: 0, stdout: "" }, "rev-parse HEAD": { status: 0, stdout: "a".repeat(40) }, "rev-parse @{upstream}": { status: 0, stdout: "a".repeat(40) } };
  assert.equal(checkoutProblem(dir, "conveyor.config.mjs", "dev", fakeGit(good)), "");
  const cases = {
    "no --base": [undefined, {}, /needs --base/],
    "PR branch": ["dev", { "rev-parse --abbrev-ref": { status: 0, stdout: "feature" } }, /on feature, not dev/],
    "dirty": ["dev", { status: { status: 0, stdout: " M x" } }, /uncommitted/],
    "behind upstream": ["dev", { "rev-parse @{upstream}": { status: 0, stdout: "b".repeat(40) } }, /upstream's tip/],
    "untracked module": ["dev", { "ls-files": { status: 1, stdout: "" } }, /not a tracked file/],
  };
  for (const [name, [base, change, why]] of Object.entries(cases)) assert.match(checkoutProblem(dir, "conveyor.config.mjs", base, fakeGit({ ...good, ...change })), why, name);
  assert.match(checkoutProblem(dir, "../missing.mjs", "dev", fakeGit(good)), /does not exist/);
  writeFileSync(join(dir, "..", `${basename(dir)}-outside.mjs`), "export default {};\n");
  t.after(() => rmSync(join(dir, "..", `${basename(dir)}-outside.mjs`), { force: true }));
  assert.match(checkoutProblem(dir, `../${basename(dir)}-outside.mjs`, "dev", fakeGit(good)), /outside the checkout/);
  const errors = [];
  const code = await runEmbedded("conveyor.config.mjs", ["tick"], { cwd: dir, err: (line) => errors.push(line), load: () => assert.fail("loaded"), git: fakeGit({ ...good, "rev-parse --abbrev-ref": { status: 0, stdout: "feature" } }) });
  assert.equal(code, 2);
  assert.match(errors.join("\n"), /refusing to load/);
  const named = await runEmbedded("conveyor.config.mjs", ["--base", "dev", "tick"], { cwd: dir, err: (line) => errors.push(line), load: async () => ({ default: { base: "main" } }), git: fakeGit(good) });
  assert.equal(named, 2);
  assert.match(errors.join("\n"), /names base main, not --base dev/);
});

// Real git, not a fake: a clone of a bare origin, so `@{upstream}` exists.
const git = (cwd, ...args) => {
  const result = spawnSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};

test("checkoutProblem against a real checkout: clean on base passes; a branch, an edit or an unpushed commit fails", (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "conveyor-embedded-git-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  spawnSync("git", ["init", "--bare", "-b", "dev", origin]);
  spawnSync("git", ["clone", "-q", origin, work]);
  git(work, "checkout", "-q", "-b", "dev");
  writeFileSync(join(work, "conveyor.config.mjs"), "export default {};\n");
  git(work, "add", ".");
  git(work, "commit", "-qm", "config");
  git(work, "push", "-q", "-u", "origin", "dev");
  assert.equal(checkoutProblem(work, "conveyor.config.mjs", "dev"), "");
  writeFileSync(join(work, "conveyor.config.mjs"), "export default { base: 'x' };\n");
  assert.match(checkoutProblem(work, "conveyor.config.mjs", "dev"), /uncommitted/);
  git(work, "commit", "-qam", "local");
  assert.match(checkoutProblem(work, "conveyor.config.mjs", "dev"), /upstream's tip/);
  git(work, "checkout", "-q", "-b", "feature");
  assert.match(checkoutProblem(work, "conveyor.config.mjs", "dev"), /on feature, not dev/);
  git(work, "checkout", "-q", "dev");
  git(work, "reset", "-q", "--hard", "origin/dev");
  assert.equal(checkoutProblem(work, "conveyor.config.mjs", "dev"), "");
  git(work, "update-index", "--assume-unchanged", "conveyor.config.mjs");
  writeFileSync(join(work, "conveyor.config.mjs"), "export default { base: 'y' };\n");
  assert.equal(git(work, "status", "--porcelain"), "");
  assert.match(checkoutProblem(work, "conveyor.config.mjs", "dev"), /assume-unchanged or skip-worktree/);
});

test("status --json turns a failure that only wrote to stderr into one error document", async () => {
  const lines = [];
  const errors = [];
  const noop = () => {};
  const config = {
    base: "dev", baseWorkflow: "ci.yml", release: { branch: "main" }, switchVariable: "ACTIVE", clearedContext: "conveyor/cleared", stateName: "worker",
    ageAlarms: { pokeHours: 1, tellHours: 2 },
    adapters: { approved: noop, changeDigest: noop, heldDigest: noop, readHeld: noop, activeUntil: noop, commando: noop, heldBy: () => [], isGateContext: () => false,
      wrangleMerge: noop, approvedWork: () => () => [], approvalClock: () => new Map(), DOCS_ONLY: /^docs\//,
      gitDir: () => { throw new Error("not inside a git repository"); } },
  };
  const code = await runEmbedded("x.mjs", ["status", "--json"], { out: (line) => lines.push(line), err: (line) => errors.push(line), load: async () => ({ default: config }) });
  assert.equal(code, 1);
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), { ok: false, error: { code: "status_failed", message: "not inside a git repository" } });
  assert.deepEqual(errors, []);
});
