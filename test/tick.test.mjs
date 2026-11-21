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
    holdUntil: Infinity,
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
      approved: (_dir, now, scope) => (model.holdApproval && now < model.holdUntil && scope.scope === "hold:migrations") ||
        (scope.scope === "merge" && scope.pr === "1" && scope.head === model.mergeApprovalHead),
      changeDigest: () => null,
      gitDir: () => dir,
      heldDigest: () => null,
      readHeld: () => model.heldRead ?? { head: model.pr.headRefOid, paths: model.changed, files: model.changed.map((path) => ({ path })) },
      activeUntil: () => model.until,
      commando: (_args, opts) => {
        model.consent = opts.consent;
        return opts.merge(["1"], { wantHead: model.pr.headRefOid });
      },
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
    assert.deepEqual(f.model.calls.at(-2).slice(0, 4), ["gh", "pr", "view", "1"]);
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

test("a skip directive on an untested base tip does not authorize a write", async (t) => {
  const f = fixture(t);
  f.model.baseTip = f.model.localTip = f.model.pr.baseRefOid = NEW_BASE;
  f.model.onCall = (argv) => argv[2] === `repos/{owner}/{repo}/compare/${BASE_SHA}...${NEW_BASE}`
    ? ok(["ahead", 1, ["Change runtime code [skip ci]"]]) : null;
  assert.equal(await f.run("tick", "--dry-run"), 0);
  assert.ok(f.model.lines.some((line) => line.includes("has no finished checks.yml run")));
  await f.run("tick");
  assert.deepEqual(f.model.writes, []);
  assert.equal(f.state().operation, undefined);
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

test("a retarget during the last switch read blocks the write", async (t) => {
  const f = fixture(t);
  f.model.beforeWrite = () => {
    f.model.onCall = (argv) => {
      if (argv[2]?.endsWith("/actions/variables/ACTIVE")) f.model.pr.baseRefName = "release";
      return null;
    };
  };
  assert.equal(await f.run("tick"), 0);
  assert.equal(f.model.pr.baseRefName, "release");
  assert.deepEqual(f.model.writes, []);
  assert.equal(f.state().operation, undefined);
});

test("consent and hold approvals are evaluated after the final PR read", async (t) => {
  for (const approval of ["consent", "hold"]) {
    await t.test(approval, async (caseTest) => {
      const f = fixture(caseTest);
      const expires = Date.parse(START) + 60_000;
      if (approval === "consent") f.model.until = new Date(expires);
      else Object.assign(f.model, { changed: ["db/migrations/new.sql"], holdApproval: true, holdUntil: expires });
      f.model.beforeWrite = () => {
        f.model.onCall = (argv) => {
          if (argv[1] === "pr" && argv[2] === "view") f.advance(1);
          return null;
        };
      };
      assert.equal(await f.run("tick"), 0);
      assert.equal(f.model.now, expires);
      assert.deepEqual(f.model.writes, []);
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

test("a state file under an older name still counts, and the next write goes to the current name", async (t) => {
  const f = fixture(t, { stateAliases: ["older-worker"] });
  writeFileSync(join(f.dir, "older-worker.json"), JSON.stringify({ lastTickAt: "2025-12-31T00:00:00.000Z" }));
  assert.equal(await f.run("status"), 0);
  assert.ok(f.model.lines.includes("last tick 2025-12-31T00:00:00.000Z"), f.model.lines.join("\n"));
  await f.run("tick");
  assert.ok(existsSync(f.statePath));
  assert.equal(f.state().lastTickAt, START);
  // The first save moved the older file, so the second tick finds one name, not two.
  assert.equal(existsSync(join(f.dir, "older-worker.json")), false);
  f.model.now += 60_000;
  assert.notEqual(await f.run("tick"), 3, f.model.lines.join("\n"));
  assert.equal(f.state().lastTickAt, new Date(f.model.now).toISOString());
});

test("state files under two names refuse the tick", async (t) => {
  const f = fixture(t, { stateAliases: ["older-worker"] });
  writeFileSync(join(f.dir, "older-worker.json"), JSON.stringify({ lastTickAt: "2025-12-31T00:00:00.000Z" }));
  writeFileSync(f.statePath, JSON.stringify({ lastTickAt: "2025-12-30T00:00:00.000Z" }));
  assert.equal(await f.run("tick"), 3);
  assert.match(f.model.lines.join("\n"), /both exist/);
});

test("stateAliases must be filename stems", (t) => {
  for (const value of ["old", [""], [3], ["a/b"], ["."], [".."]]) assert.throws(() => fixture(t, { stateAliases: value }), /stateAliases/);
});

test("stateAliases must be distinct and differ from stateName", (t) => {
  const f = fixture(t);
  const stem = f.conveyor.STATE_NAME.replace(/\.json$/u, "");
  for (const value of [[stem], ["old", "old"]]) assert.throws(() => fixture(t, { stateAliases: value }), /distinct names/);
});

test("an unknown config field is an error, not ignored", (t) => {
  assert.throws(() => fixture(t, { lane: { pass: () => {} } }), /lane must be a known config field/);
});

test("status --json prints one document with the switch, the last tick and each PR", async (t) => {
  const f = fixture(t);
  assert.equal(await f.run("status", "--json"), 0);
  assert.equal(f.model.lines.length, 1);
  const { ok: isOk, value } = JSON.parse(f.model.lines[0]);
  assert.equal(isOk, true);
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.version, JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
  assert.deepEqual(value.switch, { variable: "ACTIVE", on: true, value: "on", unreadable: false, why: null });
  assert.equal(value.base, BASE);
  assert.equal(value.lastTickAt, null);
  assert.deepEqual(value.prs.map(({ number, headSha }) => ({ number, headSha })), [{ number: 1, headSha: HEAD }]);
  assert.equal(value.baseGreen.green, true);
  assert.equal(await f.run("status", "--jsn"), 2);
});

test("status --json reports a failed read as one error document", async (t) => {
  const f = fixture(t);
  f.model.onCall = (argv) => (argv[1] === "pr" && argv[2] === "list" ? failure : undefined);
  assert.equal(await f.run("status", "--json"), 1);
  assert.equal(f.model.lines.length, 1);
  assert.equal(JSON.parse(f.model.lines[0]).ok, false);
});

test("status --json reports an unreadable state file as one state_corrupt document", async (t) => {
  const f = fixture(t);
  writeFileSync(f.statePath, "{not json");
  assert.equal(await f.run("status", "--json"), 1);
  assert.deepEqual(JSON.parse(f.model.lines[0]).error.code, "state_corrupt");
});

test("state under both the current and an older name refuses instead of picking one", async (t) => {
  const f = fixture(t, { stateAliases: ["older-worker"] });
  writeFileSync(f.statePath, JSON.stringify({ lastTickAt: START }));
  writeFileSync(join(f.dir, "older-worker.json"), JSON.stringify({ lastTickAt: START }));
  assert.equal(await f.run("tick"), 3);
  assert.match(f.model.lines.join("\n"), /older-worker\.json both exist/);
  assert.equal(f.model.writes.length, 0);
});

test("a tick holding an older name's lock keeps the new name's tick out", async (t) => {
  const f = fixture(t, { stateAliases: ["older-worker"] });
  // The old in-tree conveyor's lock: a file holding its live PID.
  writeFileSync(join(f.dir, "older-worker.lock"), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  assert.equal(await f.run("tick"), 0);
  assert.match(f.model.lines.join("\n"), /another tick is running|lock/);
  assert.equal(f.model.writes.length, 0);
  assert.ok(!existsSync(f.statePath));
});

test("with the window off, a merge approval at the PR's exact head merges that PR alone", async (t) => {
  const f = fixture(t, { mergeApprovals: true });
  f.model.until = null;
  assert.equal(await f.run("tick", "--dry-run"), 0);
  assert.ok(f.model.lines.some((line) => /merge nothing: conveyor is paused/.test(line)), f.model.lines.join("\n"));
  f.model.lines.length = 0;
  f.model.mergeApprovalHead = NEW_HEAD;
  await f.run("tick");
  assert.equal(f.model.writes.length, 0, "an approval at another head is no approval");
  f.model.mergeApprovalHead = HEAD;
  await f.run("tick");
  assert.equal(f.model.writes.length, 1, f.model.lines.join("\n"));
  assert.ok(f.model.writes[0].some((arg) => arg.endsWith("/pulls/1/merge")), f.model.writes[0].join(" "));
  assert.equal(f.model.consent, "approval");
});

test("a merge approval never covers an update: a stale approved PR waits with the window off", async (t) => {
  const f = fixture(t, { autoUpdate: true, mergeApprovals: true });
  f.model.until = null;
  f.model.mergeApprovalHead = HEAD;
  f.model.ahead = 1;
  await f.run("tick");
  assert.equal(f.model.writes.length, 0, f.model.lines.join("\n"));
});

test("without mergeApprovals, a merge approval merges nothing with the window off", async (t) => {
  const f = fixture(t);
  f.model.until = null;
  f.model.mergeApprovalHead = HEAD;
  await f.run("tick");
  assert.equal(f.model.writes.length, 0, f.model.lines.join("\n"));
  assert.equal(f.model.consent, undefined);
});

test("mergeApprovals must be a boolean", (t) => {
  assert.throws(() => fixture(t, { mergeApprovals: "yes" }), /mergeApprovals must be a boolean/);
});

test("a paused switch beats a merge approval, before the tick and at the last read", async (t) => {
  for (const [name, setup] of [
    ["paused before the tick", (m) => { m.switchValue = "off"; }],
    ["paused at the last read", (m) => { m.beforeWrite = () => { m.switchValue = "off"; }; }],
  ]) {
    await t.test(name, async (caseTest) => {
      const f = fixture(caseTest, { mergeApprovals: true });
      f.model.until = null;
      f.model.mergeApprovalHead = HEAD;
      setup(f.model);
      assert.equal(await f.run("tick"), 0);
      assert.equal(f.model.writes.length, 0, f.model.lines.join("\n"));
      assert.equal(f.state().operation, undefined);
    });
  }
});
