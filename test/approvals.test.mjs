// Approval file records (line counts, patch flag, old-side modes) and revoke records, with a fake gh.
// Used by: node:test.
// Run: node --test test/approvals.test.mjs.
// When: changing src/approvals.mjs.
// Env: none.
// Writes: temp dirs only.
// Exit: 0 pass, 1 a case failed.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createApprovals, mergeBaseModes } from "../src/approvals.mjs";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const MERGE_BASE = "c".repeat(40);
const blob = (n) => String(n).repeat(40);
const ok = (stdout) => ({ status: 0, stdout, stderr: "" });
const url = (path, ref) => `https://api.github.com/repos/o/r/contents/${path}?ref=${ref}`;

const approvals = (extra = {}) => createApprovals({
  HOLD_PATTERNS: [[/^migrations\//, "migrations"]],
  MAX_PR_FILES: 3000,
  heldBy: (paths) => (paths.some((path) => path.startsWith("migrations/")) ? ["migrations"] : []),
  pathsHeld: (paths) => paths.filter((path) => path.startsWith("migrations/")),
  ...extra,
});

// A files-API entry as GitHub sends it; the fake applies the same jq projection prFiles asks for.
const entry = (filename, status, extra = {}) => ({ filename, status, sha: blob(1), contents_url: url(filename, status === "removed" ? MERGE_BASE : HEAD), additions: 3, deletions: 1, patch: "@@ -1 +1 @@", ...extra });
const listed = (row) => JSON.stringify([row.filename, row.status, row.sha, row.previous_filename ?? "", row.contents_url ?? "", row.additions, row.deletions, (row.patch ?? "") !== ""]);

const fakeGh = (rows, { headModes = {}, baseModes = {}, mergeBase = MERGE_BASE, fail = new Set() } = {}) => {
  const calls = [];
  const run = (argv) => {
    calls.push(argv.join(" "));
    const [, verb, target] = argv;
    if (verb === "pr" && argv.includes("headRefOid")) return ok(JSON.stringify({ headRefOid: HEAD }));
    if (verb === "pr" && argv.includes("baseRefOid")) return fail.has("base") ? { status: 1, stdout: "", stderr: "no" } : ok(JSON.stringify({ baseRefOid: BASE }));
    if (verb === "api" && argv[3]?.endsWith("/files")) return ok(rows.map(listed).join("\n"));
    if (verb === "api" && target.includes("/compare/")) return fail.has("compare") ? { status: 1, stdout: "", stderr: "no" } : ok(`${mergeBase}\n`);
    if (verb === "api" && target.includes(`/git/trees/${HEAD}`)) return ok(JSON.stringify([false, Object.entries(headModes)]));
    if (verb === "api" && target.includes(`/git/trees/${mergeBase}`)) return fail.has("tree") ? ok(JSON.stringify([true, []])) : ok(JSON.stringify([false, Object.entries(baseModes)]));
    assert.fail(`unexpected command: ${argv.join(" ")}`);
  };
  return { run, calls };
};

test("file records carry line counts and whether GitHub gave a patch", () => {
  const rows = [entry("src/a.mjs", "modified"), entry("img/logo.png", "added", { additions: 0, deletions: 0, patch: undefined }), entry("src/big.mjs", "modified", { additions: 9000, deletions: 0, patch: "" })];
  const { run } = fakeGh(rows);
  const files = approvals().prFiles("5", run);
  assert.deepEqual(files.map(({ path, additions, deletions, hasPatch }) => [path, additions, deletions, hasPatch]), [
    ["src/a.mjs", 3, 1, true],
    ["img/logo.png", 0, 0, false],
    ["src/big.mjs", 9000, 0, false],
  ]);
  const held = approvals().readHeld("5", run);
  assert.equal(held.files[0].hasPatch, true);
  assert.equal(held.files[0].additions, 3);
});

test("allModes gives an old-side file its merge-base mode; the rest keep none", () => {
  const rows = [
    entry("src/a.mjs", "modified"),
    entry("src/gone.sh", "removed", { patch: "" }),
    entry("src/new.mjs", "renamed", { previous_filename: "src/old.mjs" }),
    entry("bin/tool", "changed"),
  ];
  const { run, calls } = fakeGh(rows, {
    headModes: { "src/a.mjs": "100644", "src/new.mjs": "100644", "bin/tool": "120000" },
    baseModes: { "src/gone.sh": "100755", "src/old.mjs": "100644", "bin/tool": "100755" },
  });
  const { files } = approvals().readHeld("5", run, { allModes: true });
  const by = Object.fromEntries(files.map((file) => [file.path, file]));
  assert.equal("previousMode" in by["src/a.mjs"], false);
  assert.equal(by["src/gone.sh"].previousMode, "100755");
  assert.equal(by["src/new.mjs"].previousMode, "100644");
  assert.equal(by["bin/tool"].mode, "120000");
  assert.equal(by["bin/tool"].previousMode, "100755");
  assert.ok(calls.some((call) => call.includes(`compare/${BASE}...${HEAD}`)));
});

test("without allModes, or with no old side, the merge base is never read", () => {
  const plain = fakeGh([entry("src/a.mjs", "modified")], { headModes: { "src/a.mjs": "100644" } });
  approvals().readHeld("5", plain.run, { allModes: true });
  const removed = fakeGh([entry("src/gone.mjs", "removed")]);
  approvals().readHeld("5", removed.run);
  assert.equal([...plain.calls, ...removed.calls].some((call) => call.includes("/compare/")), false);
});

test("an unreadable merge base leaves previousMode undefined, never a guess", async (t) => {
  const rows = [entry("src/gone.sh", "removed")];
  for (const [name, options] of [
    ["base read fails", { fail: new Set(["base"]) }],
    ["compare fails", { fail: new Set(["compare"]) }],
    ["tree truncated", { fail: new Set(["tree"]) }],
    ["removed entry listed at another commit", { mergeBase: "d".repeat(40) }],
  ]) {
    await t.test(name, () => {
      const { run } = fakeGh(rows, { baseModes: { "src/gone.sh": "100755" }, ...options });
      const { files } = approvals().readHeld("5", run, { allModes: true });
      assert.equal(files[0].previousMode, undefined);
      assert.equal("previousMode" in files[0], true);
    });
  }
});

test("mergeBaseModes takes a known base without reading the PR, and refuses a bad SHA", () => {
  const { run, calls } = fakeGh([], { baseModes: { "x": "100644" } });
  assert.deepEqual([...mergeBaseModes("5", HEAD, [], run, BASE)], [["x", "100644"]]);
  assert.equal(calls.some((call) => call.includes("baseRefOid")), false);
  assert.equal(mergeBaseModes("5", HEAD, [], run, "nope"), null);
  assert.equal(mergeBaseModes("5", "short", [], run, BASE), null);
});

test("bounded reads carry the same counts and patch flag", () => {
  const files = [{ filename: "src/a.mjs", status: "modified", sha: blob(1), contents_url: url("src/a.mjs", HEAD), additions: 2, deletions: 5, hasPatch: true }];
  const run = (argv) => {
    if (argv[1] === "pr") return ok(JSON.stringify({ headRefOid: HEAD, baseRefOid: BASE, baseRefName: "dev", changedFiles: 1 }));
    if (argv[2].includes("/compare/")) return ok(JSON.stringify({ base: BASE, files }));
    assert.fail(`unexpected command: ${argv.join(" ")}`);
  };
  const held = approvals({ boundedReads: true }).readHeld("5", run, { base: BASE, baseName: "dev" });
  assert.deepEqual(held.files.map(({ additions, deletions, hasPatch }) => [additions, deletions, hasPatch]), [[2, 5, true]]);
});

test("a revoke voids the grants for its PR and scope written before it, and is never a grant", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "conveyor-revoke-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const now = new Date("2026-01-01T12:00:00.000Z");
  const expires = "2026-01-01T20:00:00.000Z";
  const grant = (pr, head, at) => ({ pr, scope: "merge", head, at, expires });
  const lines = [
    grant(5, HEAD, "2026-01-01T10:00:00.000Z"),
    grant(6, HEAD, "2026-01-01T10:00:00.000Z"),
    grant(5, BASE, "2026-01-01T10:00:00.000Z"),
    { ...grant(5, HEAD, "2026-01-01T11:00:00.000Z"), revoke: true },
  ];
  const write = (records) => writeFileSync(join(dir, "conveyor-approvals.log"), `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);
  write(lines);
  const a = approvals();
  assert.equal(a.approved(dir, now, { pr: "5", scope: "merge", head: HEAD }), false);
  assert.equal(a.approved(dir, now, { pr: "6", scope: "merge", head: HEAD }), true);
  // An earlier grant at another head of the same PR and scope goes too.
  assert.equal(a.approved(dir, now, { pr: "5", scope: "merge", head: BASE }), false);
  assert.equal(a.activeApprovals(dir, now).some((record) => record.revoke === true), false);
  // A later grant at the same head stands.
  write([...lines, grant(5, HEAD, "2026-01-01T11:30:00.000Z")]);
  assert.equal(a.approved(dir, now, { pr: "5", scope: "merge", head: HEAD }), true);
  // A revoke alone never reads as a yes.
  write([lines[3]]);
  assert.equal(a.approved(dir, now, { pr: "5", scope: "merge", head: HEAD }), false);
});

test("a held-class grant matched by digest at another head is voided by a revoke at any head", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "conveyor-revoke-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const now = new Date("2026-01-01T12:00:00.000Z");
  const expires = "2026-01-01T20:00:00.000Z";
  const scope = "hold:migrations";
  writeFileSync(join(dir, "conveyor-approvals.log"), [
    { pr: 5, scope, head: HEAD, digest: "d1", at: "2026-01-01T10:00:00.000Z", expires },
    { pr: 5, scope, head: BASE, revoke: true, at: "2026-01-01T11:00:00.000Z", expires },
  ].map((r) => JSON.stringify(r)).join("\n"));
  assert.equal(approvals().approved(dir, now, { pr: "5", scope, head: MERGE_BASE, digest: "d1" }), false);
});

test("a revoke fails closed: no or bad `at` on either side voids, and its expiry never matters", async (t) => {
  const now = new Date("2026-01-01T12:00:00.000Z");
  const expires = "2026-01-01T20:00:00.000Z";
  const grant = { pr: 5, scope: "merge", head: HEAD, at: "2026-01-01T10:00:00.000Z", expires };
  const revoke = { pr: 5, scope: "merge", head: HEAD, revoke: true, at: "2026-01-01T11:00:00.000Z", expires };
  const cases = {
    "revoke without at": [grant, { ...revoke, at: undefined }],
    "revoke with garbage at": [grant, { ...revoke, at: "soon" }],
    "grant without at": [{ ...grant, at: undefined }, revoke],
    "revoke already expired": [grant, { ...revoke, expires: "2026-01-01T11:30:00.000Z" }],
    "revoke with no expiry": [grant, { ...revoke, expires: undefined }],
    "revoke naming the PR as a string": [grant, { ...revoke, pr: "5" }],
  };
  for (const [name, records] of Object.entries(cases)) {
    await t.test(name, (tt) => {
      const dir = mkdtempSync(join(tmpdir(), "conveyor-revoke-"));
      tt.after(() => rmSync(dir, { recursive: true, force: true }));
      writeFileSync(join(dir, "conveyor-approvals.log"), records.map((r) => JSON.stringify(r)).join("\n"));
      assert.equal(approvals().approved(dir, now, { pr: "5", scope: "merge", head: HEAD }), false);
    });
  }
});

test("the package root exports mergeBaseModes", async () => {
  const root = await import("../src/index.mjs");
  assert.equal(root.mergeBaseModes, mergeBaseModes);
});
