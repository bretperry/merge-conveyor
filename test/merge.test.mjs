// Exercise the merge batch's GitHub boundary with a fake clock and immutable SHAs.
import assert from "node:assert/strict";
import { test } from "node:test";

import { checkRows, ciVerdict } from "../src/ci.mjs";
import { createMerge } from "../src/merge.mjs";

const HEAD = "1".repeat(40);
const NEW_HEAD = "2".repeat(40);
const BASE = "3".repeat(40);
const NEW_BASE = "4".repeat(40);
const MERGED = "5".repeat(40);
const WHEN = "2026-01-01T12:00:00.000Z";
const check = { __typename: "CheckRun", name: "Build", status: "COMPLETED", conclusion: "SUCCESS" };
const status = { __typename: "StatusContext", context: "outside", state: "SUCCESS" };
const rule = { type: "required_status_checks", parameters: { strict_required_status_checks_policy: true, required_status_checks: [{ context: "Build" }] } };
const result = (value, code = 0) => ({ status: code, stdout: typeof value === "string" ? value : JSON.stringify(value), stderr: "" });

const fixture = () => {
  const pr = {
    number: 7, state: "OPEN", headRefOid: HEAD, baseRefName: "integration", baseRefOid: BASE,
    isDraft: false, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", statusCheckRollup: [check, status],
  };
  const model = { pr, rules: [rule], writes: [], out: [], views: 0 };
  const merge = createMerge({ base: "integration", releaseBranch: "release", loadHeavyChecks: async () => [{ name: "Build", classify: () => true }], isGateContext: (name) => name.startsWith("gate/") });
  const run = (argv) => {
    if (argv[1] === "pr" && argv[2] === "view") {
      model.views += 1;
      return result(pr);
    }
    if (argv[1] === "pr" && argv[2] === "diff") return result("src/example.mjs");
    if (argv[2].includes("/rules/branches/")) return result(model.rules);
    if (argv[2].includes("/protection/required_status_checks")) return result(model.classic ?? {});
    if (argv[2] === "--method") {
      model.writes.push(argv);
      Object.assign(pr, { state: "MERGED", mergedAt: WHEN, mergeCommit: { oid: MERGED } });
      return result({}, 1);
    }
    assert.fail(`unexpected command: ${argv.join(" ")}`);
  };
  let time = 0;
  return {
    model,
    start: (opts = {}, args = []) => merge.main(["7", "--wait-minutes", "0.05", "--poll-seconds", "1", ...args], {
      run, clock: () => time, sleep: async (seconds) => { time += seconds; }, out: (line) => model.out.push(line), err: (line) => model.out.push(line), ...opts,
    }),
  };
};

test("merge uses a configured base and method, with GitHub state as the outcome", async () => {
  const f = fixture();
  assert.equal(await f.start({ wantHead: HEAD, mergeMethod: "squash" }), 0);
  assert.deepEqual(f.model.writes, [["gh", "api", "--method", "PUT", "repos/{owner}/{repo}/pulls/7/merge", "-f", `sha=${HEAD}`, "-f", "merge_method=squash"]]);
  assert.ok(f.model.views >= 5);
});

test("merge refuses a moved head or base after the stable polls", async (t) => {
  for (const [field, value] of [["headRefOid", NEW_HEAD], ["baseRefOid", NEW_BASE], ["baseRefName", "wrong-target"]]) {
    await t.test(field, async () => {
      const f = fixture();
      assert.equal(await f.start({ wantHead: HEAD, beforeMerge: () => { f.model.pr[field] = value; } }), 1);
      assert.deepEqual(f.model.writes, []);
    });
  }
});

test("merge requires configured strict branch protection and a heavy pass", async (t) => {
  await t.test("no strict rules", async () => {
    const f = fixture();
    f.model.rules = [];
    assert.equal(await f.start(), 1);
    assert.deepEqual(f.model.writes, []);
  });
  await t.test("classic strict protection", async () => {
    const f = fixture();
    f.model.rules = [];
    f.model.classic = { strict: true, checks: [{ context: "Build" }] };
    assert.equal(await f.start(), 0);
    assert.equal(f.model.writes.length, 1);
  });
  await t.test("heavy job skipped", async () => {
    const f = fixture();
    f.model.pr.statusCheckRollup[0] = { ...check, conclusion: "SKIPPED" };
    assert.equal(await f.start(), 1);
    assert.deepEqual(f.model.writes, []);
  });
});

test("CI rollups keep provider types separate and fail closed on unknown outcomes", () => {
  assert.equal(ciVerdict([]), null);
  assert.equal(ciVerdict([check, status]), "green");
  assert.equal(ciVerdict([{ ...check, status: "IN_PROGRESS" }]), "pending");
  assert.equal(ciVerdict([{ ...check, conclusion: "OTHER" }]), "unknown");
  assert.equal(ciVerdict([{ ...check, status: "SUCCESS" }]), "unknown");
  assert.equal(ciVerdict([{ ...status, state: "FAILURE" }, check]), "red");
  const sameName = { ...check, name: status.context };
  assert.equal(checkRows([status, sameName]).length, 2);
  assert.equal(ciVerdict(checkRows([sameName, { ...sameName, conclusion: "FAILURE" }])), "red");
});
