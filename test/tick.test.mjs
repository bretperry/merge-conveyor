// Exercise the worker through its existing entry point with a fake GitHub and a real journal.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createConveyor } from "../src/index.mjs";

const BASE = "integration";
const BASE_SHA = "a".repeat(40);
const HEAD = "b".repeat(40);
const NEW_HEAD = "c".repeat(40);
const NEW_BASE = "d".repeat(40);
const MERGE_SHA = "e".repeat(40);
const START = "2026-01-01T12:00:00.000Z";
const CONTEXT = "conveyor/cleared";
const success = { __typename: "CheckRun", name: "Build", status: "COMPLETED", conclusion: "SUCCESS" };
const cleared = { __typename: "StatusContext", context: CONTEXT, state: "SUCCESS", createdAt: START };
const ready = () => ({
  number: 1, title: "Candidate", state: "OPEN", baseRefName: BASE, baseRefOid: BASE_SHA, headRefOid: HEAD,
  isDraft: false, isCrossRepository: false, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN",
  statusCheckRollup: [success, cleared],
});
const ok = (value) => ({ status: 0, stdout: typeof value === "string" ? value : JSON.stringify(value), stderr: "" });
const failure = { status: 1, stdout: "", stderr: "fixture read failed" };

const fixture = (t, config = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "conveyor-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const model = {
    now: Date.parse(START),
    until: new Date("2026-01-01T18:00:00.000Z"),
    switchValue: "on",
    baseTip: BASE_SHA,
    baseRun: BASE_SHA,
    localTip: BASE_SHA,
    status: ok(""),
    pr: ready(),
    changed: ["src/file.mjs"],
    holdApproval: false,
    ahead: 0,
    strict: true,
    publisherId: 100,
    calls: [],
    lines: [],
    writes: [],
  };
  const run = (argv) => {
    model.calls.push(argv);
    const override = model.onCall?.(argv);
    if (override) return override;
    const [cmd, group, verb, ...args] = argv;
    if (cmd === "git") {
      if (argv.at(-1) === "--porcelain") return model.status;
      if (argv.includes("--abbrev-ref")) return ok(BASE);
      if (argv.at(-1) === "HEAD") return ok(model.localTip);
    }
    if (cmd === "gh" && group === "api") {
      if (verb.includes("/actions/variables/")) return ok({ value: model.switchValue });
      if (verb.endsWith(`/commits/${BASE}`)) return ok(model.baseTip);
      if (verb.includes("/compare/")) return ok(model.ahead);
      if (verb.includes(`/rules/branches/${BASE}`)) return ok(model.strict ? [{ type: "required_status_checks", parameters: { strict_required_status_checks_policy: true, required_status_checks: [{ context: "Build" }] } }] : []);
      if (verb.endsWith("/protection/required_status_checks")) return failure;
      if (verb.endsWith("/statuses?per_page=100")) return ok([{ state: "success", context: CONTEXT, creator: { id: model.publisherId } }]);
      if (verb === "--method") {
        model.writes.push(argv);
        return model.onWrite?.(argv) ?? ok({});
      }
    }
    if (group === "run" && verb === "list") return ok([{ status: "completed", conclusion: "success", headSha: model.baseRun }]);
    if (group === "pr" && verb === "list") {
      if (args.includes("release")) return ok([]);
      if (args.includes("merged")) return ok([]);
      return ok(model.pr.state === "OPEN" ? [model.pr] : []);
    }
    if (group === "pr" && verb === "view") return model.prUnreadable ? failure : ok(model.pr);
    assert.fail(`unexpected command: ${argv.join(" ")}`);
  };
  const conveyor = createConveyor({
    base: BASE, baseWorkflow: "checks.yml", release: { branch: "release" }, switchVariable: "ACTIVE",
    clearedContext: CONTEXT, clearancePublisherId: 100, stateName: "worker", ageAlarms: { pokeHours: 2, tellHours: 4 },
    ...config,
    adapters: {
      approved: (_dir, _now, scope) => model.holdApproval && scope.scope === "hold:migrations",
      changeDigest: () => null,
      gitDir: () => dir,
      heldDigest: () => null,
      readHeld: () => model.heldRead ?? { head: model.pr.headRefOid, paths: model.changed, files: model.changed.map((path) => ({ path })) },
      activeUntil: () => model.until,
      commando: (_args, opts) => opts.merge(["1"], { wantHead: model.pr.headRefOid }),
      heldBy: (paths) => paths.some((path) => path.includes("migrations/")) ? ["migrations"] : [],
      isGateContext: (context) => context.startsWith("gate/"),
      wrangleMerge: async (_args, opts) => {
        await model.beforeWrite?.();
        // Exercise the existing injected adapter command with the worker's direct writer.
        return opts.run(["gh", "pr", "merge", "1", "--merge", "--match-head-commit", opts.wantHead]).status;
      },
      approvedWork: () => () => [],
      approvalClock: () => new Map(),
      DOCS_ONLY: /^docs\//,
    },
  });
  const statePath = join(dir, conveyor.STATE_NAME);
  return {
    dir, statePath, model, conveyor,
    state: () => JSON.parse(readFileSync(statePath, "utf8")),
    run: (...args) => conveyor.main(args, { run, clock: () => new Date(model.now), env: {}, out: (line) => model.lines.push(line), err: (line) => model.lines.push(line) }),
    advance: (minutes) => { model.now += minutes * 60_000; },
    merge: () => {
      Object.assign(model.pr, { state: "MERGED", mergedAt: new Date(model.now).toISOString(), mergeCommit: { oid: MERGE_SHA } });
    },
  };
};

test("records intent before a configured direct merge and verifies GitHub after a lost response", async (t) => {
  const f = fixture(t, { mergeMethod: "rebase" });
  f.model.onWrite = (argv) => {
    assert.deepEqual(f.state().operation, { kind: "merge", number: 1, head: HEAD, base: BASE, baseSha: BASE_SHA, at: START });
    assert.deepEqual(argv, ["gh", "api", "--method", "PUT", "repos/{owner}/{repo}/pulls/1/merge", "-f", `sha=${HEAD}`, "-f", "merge_method=rebase"]);
    f.merge();
    return failure;
  };
  assert.equal(await f.run("tick"), 0);
  assert.equal(f.state().operation, undefined);
  assert.equal(f.state().lastMergeAt, START);
  assert.equal(f.model.writes.length, 1);
});

test("rechecks mutable evidence at the write boundary", async (t) => {
  const cases = {
    head: (m) => { m.pr.headRefOid = NEW_HEAD; },
    "base tip": (m) => { m.baseTip = m.baseRun = m.localTip = m.pr.baseRefOid = NEW_BASE; },
    "PR retarget": (m) => { m.pr.baseRefName = "another-target"; },
    "missing checks": (m) => { m.pr.statusCheckRollup = [cleared]; },
    "missing required check with optional CI green": (m) => { m.pr.mergeStateStatus = "BLOCKED"; },
    "unknown mergeability": (m) => { m.pr.mergeable = "UNKNOWN"; },
    "strict checks missing": (m) => { m.strict = false; },
    "consent expires": (m) => { m.until = new Date(START); },
    "paused during wait": (m) => { m.switchValue = "off"; },
    "hold appears": (m) => { m.changed = ["db/migrations/new.sql"]; },
    "checkout status fails": (m) => { m.status = failure; },
    "untrusted status author": (m) => { m.publisherId = 200; },
    "malformed check": (m) => { m.pr.statusCheckRollup = [{ ...success, conclusion: "FUTURE" }, cleared]; },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    await t.test(name, async (caseTest) => {
      const f = fixture(caseTest);
      f.model.beforeWrite = () => mutate(f.model);
      assert.equal(await f.run("tick"), 0);
      assert.equal(f.model.writes.length, 0);
      assert.equal(f.state().operation, undefined);
    });
  }
});

test("fails closed on unreadable, incomplete, or mismatched initial evidence", async (t) => {
  const cases = {
    "read of held paths failed": (m) => { m.heldRead = { error: "can't list paths" }; },
    "held paths from another head": (m) => { m.heldRead = { head: NEW_HEAD, paths: [], files: [] }; },
    "only a clearance check run": (m) => { m.pr.statusCheckRollup = [{ ...success, name: CONTEXT }]; },
    "pending external CI": (m) => { m.pr.statusCheckRollup = [cleared, { __typename: "StatusContext", context: "external", state: "PENDING" }]; },
    "truncated rollup": (m) => { m.pr.statusCheckRollup = [cleared, ...Array(99).fill(success)]; },
    "remote read times out": (m) => { m.onCall = (argv) => argv.includes(`repos/{owner}/{repo}/commits/${BASE}`) ? failure : null; },
    "no consent": (m) => { m.until = null; },
    "list reaches its cap": (m) => { m.onCall = (argv) => argv.includes("list") && argv.includes(BASE) && !argv.includes("release") && argv.includes("open") ? ok(Array.from({ length: 200 }, (_, i) => ({ ...m.pr, number: i + 1 }))) : null; },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    await t.test(name, async (caseTest) => {
      const f = fixture(caseTest);
      mutate(f.model);
      await f.run("tick");
      assert.equal(f.model.writes.length, 0);
      assert.equal(f.state().operation, undefined);
    });
  }
});

test("a held path needs approval separate from exact-head clearance", async (t) => {
  const f = fixture(t);
  f.model.changed = ["db/migrations/new.sql"];
  await f.run("tick");
  assert.equal(f.model.writes.length, 0);
  f.model.holdApproval = true;
  f.model.onWrite = f.merge;
  await f.run("tick");
  assert.equal(f.model.writes.length, 1);
});

test("branch updates are opt-in, head-pinned and never carry clearance", async (t) => {
  for (const [label, autoUpdate, fork] of [["default off", undefined, false], ["stale fork", true, true], ["same repo", true, false]]) {
    await t.test(label, async (caseTest) => {
      const f = fixture(caseTest, { autoUpdate });
      Object.assign(f.model.pr, { isCrossRepository: fork, mergeStateStatus: "BEHIND" });
      f.model.ahead = 1;
      f.model.onWrite = (argv) => {
        assert.deepEqual(argv, ["gh", "api", "--method", "PUT", "repos/{owner}/{repo}/pulls/1/update-branch", "-f", `expected_head_sha=${HEAD}`]);
        assert.equal(f.state().operation.kind, "update");
        f.model.pr.headRefOid = NEW_HEAD;
        f.model.pr.statusCheckRollup = [{ ...success, status: "IN_PROGRESS" }];
      };
      await f.run("tick");
      assert.equal(f.model.writes.length, autoUpdate && !fork ? 1 : 0);
      if (!autoUpdate || fork) return;
      assert.equal(f.state().operation.head, HEAD);
      await f.run("tick");
      assert.equal(f.model.writes.length, 1);
      f.model.pr.statusCheckRollup = [success];
      f.model.ahead = 0;
      f.model.pr.mergeStateStatus = "CLEAN";
      await f.run("tick");
      assert.equal(f.state().operation, undefined);
      assert.equal(f.model.writes.length, 1);
      f.model.pr.statusCheckRollup.push(cleared);
      f.model.onWrite = f.merge;
      await f.run("tick");
      assert.equal(f.model.writes.length, 2);
      assert.ok(f.model.writes[1].includes(`sha=${NEW_HEAD}`));
    });
  }
});

test("a crash and failed reconciliation retain intent until GitHub confirms the result", async (t) => {
  const f = fixture(t);
  f.model.onWrite = () => {
    assert.equal(f.state().operation.head, HEAD);
    f.merge();
    throw new Error("process interrupted after submission");
  };
  assert.equal(await f.run("tick"), 3);
  assert.equal(f.state().operation.kind, "merge");
  f.model.prUnreadable = true;
  f.advance(31);
  await f.run("tick");
  assert.equal(f.state().operation.head, HEAD);
  assert.equal(f.model.writes.length, 1);
  f.model.prUnreadable = false;
  f.model.switchValue = "off";
  await f.run("tick");
  assert.equal(f.state().operation, undefined);
  assert.equal(f.state().lastMergeAt, START);
  assert.equal(f.model.writes.length, 1);
});

test("backs off an unconfirmed merge and reconciles an open PR before retrying", async (t) => {
  const f = fixture(t);
  f.model.onWrite = () => failure;
  await f.run("tick");
  assert.equal(f.state().operation.kind, "merge");
  f.advance(29);
  await f.run("tick");
  assert.equal(f.model.writes.length, 1);
  f.advance(1);
  f.model.prUnreadable = true;
  await f.run("tick");
  assert.equal(f.model.writes.length, 1);
  f.model.prUnreadable = false;
  f.model.onWrite = f.merge;
  await f.run("tick");
  assert.equal(f.model.writes.length, 2);
  assert.equal(f.state().operation, undefined);
});

test("simultaneous ticks using the same common Git dir make one request", async (t) => {
  const f = fixture(t);
  const entered = Promise.withResolvers();
  const resume = Promise.withResolvers();
  f.model.beforeWrite = () => { entered.resolve(); return resume.promise; };
  f.model.onWrite = f.merge;
  const first = f.run("tick");
  await entered.promise;
  try {
    assert.equal(await f.run("tick"), 0);
    assert.equal(f.model.writes.length, 0);
    assert.ok(f.model.lines.some((line) => line.includes("another tick")));
  } finally {
    resume.resolve();
  }
  assert.equal(await first, 0);
  assert.equal(f.model.writes.length, 1);
});

test("preserves corrupt or unsupported state and reads legacy marks", async (t) => {
  for (const content of ['{"operation":', "null", "[]", '{"schemaVersion":2}', '{"attempts":[]}', '{"outbox":[null]}', '{"operation":{"kind":"merge"}}']) {
    const f = fixture(t);
    writeFileSync(f.statePath, content);
    assert.equal(await f.run("tick"), 3);
    assert.equal(await f.run("status"), 1);
    assert.equal(readFileSync(f.statePath, "utf8"), content);
    assert.equal(f.model.writes.length, 0);
  }
  const f = fixture(t);
  const legacy = {
    alarmed: { previous: START }, attempts: { [`1@${HEAD}`]: START },
    updating: { number: 1, head: HEAD, digest: "legacy-digest", at: START },
  };
  writeFileSync(f.statePath, JSON.stringify(legacy));
  f.model.pr.headRefOid = NEW_HEAD;
  f.model.pr.statusCheckRollup = [success];
  await f.run("tick");
  assert.equal(f.state().schemaVersion, 1);
  assert.deepEqual(f.state().attempts, legacy.attempts);
  assert.equal(f.state().alarmed.previous, START);
  assert.equal(f.state().updating, undefined);
  assert.equal(f.model.writes.length, 0);
});

test("dry run is read-only and clear requires a full exact head", async (t) => {
  const f = fixture(t);
  assert.equal(await f.run("tick", "--dry-run"), 0);
  assert.equal(existsSync(f.statePath), false);
  assert.equal(f.model.writes.length, 0);
  assert.equal(await f.run("clear", "1", HEAD.slice(0, 7)), 2);
  assert.equal(await f.run("clear", "1", NEW_HEAD), 1);
  assert.equal(f.model.writes.length, 0);
  assert.equal(await f.run("clear", "1", HEAD), 0);
  assert.equal(f.model.writes.length, 1);
  assert.ok(f.model.writes[0].includes(`repos/{owner}/{repo}/statuses/${HEAD}`));
});
