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
const SECOND_MERGE = "6".repeat(40);
const WHEN = "2026-01-01T12:00:00.000Z";
const check = { __typename: "CheckRun", name: "Build", status: "COMPLETED", conclusion: "SUCCESS" };
const status = { __typename: "StatusContext", context: "outside", state: "SUCCESS" };
const rule = { type: "required_status_checks", parameters: { strict_required_status_checks_policy: true, required_status_checks: [{ context: "outside", integration_id: 12 }] } };
const result = (value, code = 0) => ({ status: code, stdout: typeof value === "string" ? value : JSON.stringify(value), stderr: "" });

const fixture = ({ batch = false } = {}) => {
  const pr = {
    number: 7, state: "OPEN", headRefOid: HEAD, baseRefName: "integration", baseRefOid: BASE,
    isDraft: false, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", statusCheckRollup: [check, status],
  };
  const second = { ...pr, number: 8, headRefOid: NEW_HEAD, statusCheckRollup: [check, status] };
  const prs = new Map(batch ? [[7, pr], [8, second]] : [[7, pr]]);
  const model = {
    pr, second, rules: [rule], writes: [], out: [], views: 0, confirms: true,
    comparison: { status: "ahead", behind_by: 0, files: [{ filename: "src/example.mjs" }] },
  };
  const merge = createMerge({ base: "integration", releaseBranch: "release", loadHeavyChecks: async () => [{ name: "Build", classify: (paths) => paths.some((path) => path.startsWith("src/")) }], isGateContext: (name) => name.startsWith("gate/") });
  const run = (argv) => {
    if (argv[1] === "pr" && argv[2] === "view") {
      model.views += 1;
      return result(prs.get(Number(argv[3])));
    }
    if (argv[1] === "pr" && argv[2] === "diff") return result("src/example.mjs");
    if (argv[2].includes("/rules/branches/")) return result(model.rules);
    if (argv[2].includes("/protection/required_status_checks")) return result(model.classic ?? {});
    if (argv[2] === `repos/{owner}/{repo}/compare/${MERGED}...${NEW_HEAD}?per_page=1`) return result(model.comparison);
    if (argv[2] === "--method") {
      model.writes.push(argv);
      const number = Number(argv[4].match(/\/pulls\/(\d+)\/merge$/)[1]);
      const oid = number === 7 ? MERGED : SECOND_MERGE;
      if (model.confirms) {
        Object.assign(prs.get(number), { state: "MERGED", mergedAt: WHEN, mergeCommit: { oid } });
        for (const candidate of prs.values()) if (candidate.state === "OPEN") candidate.baseRefOid = oid;
        model.afterMerge?.(number);
      }
      return result({}, 1);
    }
    assert.fail(`unexpected command: ${argv.join(" ")}`);
  };
  let time = 0;
  return {
    model,
    start: (opts = {}, args = []) => merge.main([...prs.keys()].map(String).concat("--wait-minutes", "0.05", "--poll-seconds", "1", ...args), {
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
    f.model.classic = { strict: true, checks: [{ context: "Build", app_id: null }] };
    assert.equal(await f.start(), 0);
    assert.equal(f.model.writes.length, 1);
  });
  await t.test("classic strict contexts", async () => {
    const f = fixture();
    f.model.rules = [];
    f.model.classic = { strict: true, contexts: ["outside"] };
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

test("malformed required check configurations do not authorize a merge", async (t) => {
  const cases = {
    "null ruleset check": { ruleset: [null] },
    "empty ruleset context": { ruleset: [{ context: " " }] },
    "mixed ruleset checks": { ruleset: [{ context: "Build" }, { context: 12 }] },
    "malformed integration ID": { ruleset: [{ context: "Build", integration_id: "12" }] },
    "null classic check": { classic: { checks: [null] } },
    "malformed classic app ID": { classic: { checks: [{ context: "Build", app_id: "12" }] } },
    "malformed classic context": { classic: { contexts: ["outside", { context: "Build" }] } },
    "malformed classic checks with valid contexts": { classic: { contexts: ["outside"], checks: [null] } },
  };
  for (const [name, { ruleset, classic }] of Object.entries(cases)) {
    await t.test(name, async () => {
      const f = fixture();
      f.model.rules = ruleset ? [{ ...rule, parameters: { ...rule.parameters, required_status_checks: ruleset } }] : [];
      f.model.classic = { strict: true, ...classic };
      assert.equal(await f.start(), 1);
      assert.deepEqual(f.model.writes, []);
    });
  }
});

test("a confirmed manual merge can advance the base for the rest of the batch", async () => {
  const f = fixture({ batch: true });
  f.model.afterMerge = () => {
    // The new comparison only touches docs, so this base does not require a heavy build.
    f.model.comparison.files = [{ filename: "docs/change.md" }];
    f.model.second.statusCheckRollup = [status, { ...check, conclusion: "SKIPPED" }];
  };
  assert.equal(await f.start(), 0);
  assert.deepEqual(f.model.writes.map((argv) => argv[6]), [`sha=${HEAD}`, `sha=${NEW_HEAD}`]);
});

test("the rest of a manual batch needs a confirmed base and fresh eligibility", async (t) => {
  const cases = {
    "unrelated base movement": (m) => { m.second.baseRefOid = NEW_BASE; },
    "head moved": (m) => { m.second.headRefOid = HEAD; },
    "retargeted PR": (m) => { m.second.baseRefName = "elsewhere"; },
    "head does not contain confirmed base": (m) => { m.comparison = { status: "diverged", behind_by: 1 }; },
    "GitHub reports blocked": (m) => { m.second.mergeStateStatus = "BLOCKED"; },
    "strict protection was removed": (m) => { m.rules = []; },
    "heavy check missing": (m) => { m.second.statusCheckRollup = [status]; },
    "rename needs the heavy check": (m) => {
      m.comparison.files = [{ filename: "docs/example.mjs", previous_filename: "src/example.mjs" }];
      m.second.statusCheckRollup = [status];
    },
    "capped path list needs the heavy check": (m) => {
      m.comparison.files = Array(300).fill({ filename: "docs/example.md" });
      m.second.statusCheckRollup = [status];
    },
  };
  for (const [name, change] of Object.entries(cases)) {
    await t.test(name, async () => {
      const f = fixture({ batch: true });
      f.model.afterMerge = () => change(f.model);
      assert.equal(await f.start(), 1);
      assert.deepEqual(f.model.writes.map((argv) => argv[6]), [`sha=${HEAD}`]);
      assert.equal(f.model.second.state, "OPEN");
    });
  }
  await t.test("unknown merge result", async () => {
    const f = fixture({ batch: true });
    f.model.confirms = false;
    assert.equal(await f.start(), 1);
    assert.deepEqual(f.model.writes.map((argv) => argv[6]), [`sha=${HEAD}`]);
    assert.equal(f.model.second.state, "OPEN");
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
