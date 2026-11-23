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

const fixture = ({ batch = false, bases = { base: "integration", releaseBranch: "release" } } = {}) => {
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
  const merge = createMerge({ ...bases, loadHeavyChecks: async () => [{ name: "Build", classify: (paths) => paths.some((path) => path.startsWith("src/")) }], isGateContext: (name) => name.startsWith("gate/") });
  const run = (argv) => {
    if (argv[1] === "pr" && argv[2] === "checks" && argv.includes("--required")) return result(model.required ?? []);
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
    elapsed: () => time,
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

// The pre-0.2 cases, kept as they were.
test("lenient ciVerdict keeps the pre-0.2 reading; the default is unchanged", () => {
  const lenient = (rollup) => ciVerdict(rollup, { lenient: true });
  assert.equal(lenient([]), null);
  assert.equal(lenient([{ status: "COMPLETED", conclusion: "SUCCESS" }, { status: "COMPLETED", conclusion: "SKIPPED" }]), "green");
  assert.equal(lenient([{ status: "IN_PROGRESS", conclusion: "" }, { status: "COMPLETED", conclusion: "SUCCESS" }]), "pending");
  assert.equal(lenient([{ status: "IN_PROGRESS", conclusion: "" }, { status: "COMPLETED", conclusion: "FAILURE" }]), "red");
  assert.equal(lenient([{ state: "PENDING" }]), "pending");
  assert.equal(lenient([{ state: "ERROR" }]), "red");
  // Where the readings differ: a STALE or unknown completed outcome, and a queued run.
  assert.equal(lenient([{ ...check, conclusion: "STALE" }]), "green");
  assert.equal(ciVerdict([{ ...check, conclusion: "STALE" }]), "red");
  assert.equal(lenient([{ ...check, conclusion: "OTHER" }]), "green");
  assert.equal(ciVerdict([{ ...check, conclusion: "OTHER" }]), "unknown");
  assert.equal(lenient([{ ...check, status: "QUEUED", conclusion: "" }]), "pending");
  assert.equal(lenient("not a rollup"), "unknown");
  // A caller passing ciVerdict to map() hands it an index, which is not the option.
  assert.deepEqual([[{ ...check, conclusion: "OTHER" }]].map(ciVerdict), ["unknown"]);
});

const HEAVY = async () => [{ name: "Build", classify: (paths) => paths.some((path) => path.startsWith("src/")) }];

test("createMerge takes the pre-0.2 base names too, and refuses two that disagree", async () => {
  const f = fixture({ bases: { BASE_BRANCH: "integration", SHIP_BASE_BRANCH: "release" } });
  assert.equal(await f.start(), 0);
  assert.equal(f.model.writes.length, 1);
  assert.equal(await fixture({ bases: { base: "integration", BASE_BRANCH: "integration", releaseBranch: "release", SHIP_BASE_BRANCH: "release" } }).start(), 0);
  assert.throws(() => createMerge({ loadHeavyChecks: HEAVY, isGateContext: () => false, base: "dev", BASE_BRANCH: "main" }), /disagree/);
  assert.throws(() => createMerge({ loadHeavyChecks: HEAVY, isGateContext: () => false, releaseBranch: "main", SHIP_BASE_BRANCH: "prod" }), /disagree/);
});

// The pre-0.2 --ship cases, with configured bases.
test("--ship reaches only the release branch", async (t) => {
  await t.test("refuses a PR based on the feature base", async () => {
    const f = fixture();
    assert.equal(await f.start({}, ["--ship"]), 1);
    assert.deepEqual(f.model.writes, []);
    assert.match(f.model.out.join("\n"), /refusing/);
  });
  await t.test("merges a release-based PR and says it deploys", async () => {
    const f = fixture();
    f.model.pr.baseRefName = "release";
    assert.equal(await f.start({}, ["--ship"]), 0, f.model.out.join("\n"));
    assert.equal(f.model.writes.length, 1);
    assert.match(f.model.out.join("\n"), /SHIP: merging #7 into release deploys production immediately/);
  });
  await t.test("the same with the pre-0.2 names", async () => {
    const f = fixture({ bases: { BASE_BRANCH: "integration", SHIP_BASE_BRANCH: "release" } });
    f.model.pr.baseRefName = "release";
    assert.equal(await f.start({}, ["--ship"]), 0);
  });
  await t.test("takes exactly one PR, never with --partial, and names the bases", async () => {
    const f = fixture({ batch: true });
    assert.equal(await f.start({}, ["--ship"]), 2);
    assert.match(f.model.out.join("\n"), /--ship takes exactly one PR \(the integration -> release ship PR\)/);
    assert.equal(await fixture().start({}, ["--ship", "--partial"]), 2);
    assert.equal(f.model.views, 0);
  });
  await t.test("refuses a release branch that is unset or equals the base", async () => {
    for (const bases of [{ base: "integration" }, { base: "integration", releaseBranch: "integration" }, { BASE_BRANCH: "integration", SHIP_BASE_BRANCH: "integration" }]) {
      const f = fixture({ bases });
      assert.equal(await f.start({}, ["--ship"]), 2);
      assert.equal(f.model.views, 0);
      assert.deepEqual(f.model.writes, []);
    }
  });
});

// The pre-0.2 earlyExit and wantHeads cases.
test("wantHeads pins each PR to its own head and must cover every PR", async (t) => {
  await t.test("both vetted heads merge, and onMerged hears each", async () => {
    const f = fixture({ batch: true });
    const merged = [];
    assert.equal(await f.start({ wantHeads: new Map([[7, HEAD], [8, NEW_HEAD]]), onMerged: (n) => merged.push(n) }), 0);
    assert.deepEqual(merged, [7, 8]);
  });
  await t.test("a PR past its vetted head merges none", async () => {
    const f = fixture({ batch: true });
    assert.equal(await f.start({ wantHeads: new Map([[7, HEAD], [8, "d".repeat(40)]]) }), 1);
    assert.deepEqual(f.model.writes, []);
    assert.match(f.model.out.join("\n"), /#8 NOT QUALIFIED: head moved/);
  });
  await t.test("one missing or short head is a usage error", async () => {
    for (const wantHeads of [new Map(), new Map([[7, HEAD]]), new Map([[7, HEAD], [8, "abc"]]), { 7: HEAD, 8: NEW_HEAD }]) {
      const f = fixture({ batch: true });
      assert.equal(await f.start({ wantHeads }), 2);
      assert.equal(f.model.views, 0);
    }
  });
});

test("earlyExit stops the wait at once on a conflict or a red required check", async (t) => {
  await t.test("conflict", async () => {
    const f = fixture({ batch: true });
    f.model.second.mergeable = "CONFLICTING";
    assert.equal(await f.start({ earlyExit: true }, ["--wait-minutes", "55"]), 1);
    assert.deepEqual(f.model.writes, []);
    assert.equal(f.elapsed(), 0);
    assert.deepEqual(f.model.out.filter((line) => line.startsWith("stopped early")), ["stopped early: #8 merge conflict with integration; merged none"]);
    assert.doesNotMatch(f.model.out.join("\n"), /NOT QUALIFIED/);
  });
  await t.test("red required check", async () => {
    const f = fixture();
    f.model.pr.statusCheckRollup = [{ ...check, conclusion: "FAILURE" }, status];
    f.model.required = [{ name: "Build", bucket: "fail", workflow: "CI", startedAt: WHEN }];
    assert.equal(await f.start({ earlyExit: true }, ["--wait-minutes", "55"]), 1);
    assert.equal(f.elapsed(), 0);
    assert.match(f.model.out.join("\n"), /stopped early: #7 required check failing: Build; merged none/);
  });
  await t.test("a red check that isn't required keeps waiting", async () => {
    const f = fixture();
    f.model.pr.statusCheckRollup = [{ ...check, conclusion: "FAILURE" }, status];
    assert.equal(await f.start({ earlyExit: true }), 1);
    assert.ok(f.elapsed() > 0);
    assert.doesNotMatch(f.model.out.join("\n"), /stopped early/);
  });
  await t.test("without earlyExit a conflict still waits", async () => {
    const f = fixture();
    f.model.pr.mergeable = "CONFLICTING";
    assert.equal(await f.start(), 1);
    assert.ok(f.elapsed() > 0);
  });
});

test("a throwing onMerged is reported, the batch goes on, and the exit is 1", async () => {
  const f = fixture({ batch: true });
  const heard = [];
  const onMerged = (n) => {
    heard.push(n);
    if (n === 7) throw new Error("ledger full");
  };
  assert.equal(await f.start({ onMerged }), 1);
  assert.deepEqual(f.model.writes.map((argv) => argv[6]), [`sha=${HEAD}`, `sha=${NEW_HEAD}`]);
  assert.deepEqual(heard, [7, 8]);
  assert.match(f.model.out.join("\n"), /#7 onMerged failed: ledger full/);
  assert.equal(f.model.out.at(-1), "onMerged failed for #7; those PRs are merged");
});

test("an unconfirmed merge never calls onMerged", async () => {
  const f = fixture({ batch: true });
  f.model.confirms = false;
  const heard = [];
  assert.equal(await f.start({ onMerged: (n) => heard.push(n) }), 1);
  assert.deepEqual(heard, []);
});

test("a batch that lands fewer than it named says so last", async () => {
  const f = fixture({ batch: true });
  f.model.afterMerge = () => { f.model.second.mergeStateStatus = "BLOCKED"; };
  assert.equal(await f.start(), 1);
  assert.equal(f.model.out.at(-1), "merged 1 of 2, skipped 1");
});
