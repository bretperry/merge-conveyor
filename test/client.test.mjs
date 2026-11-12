import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { formatQueue, runCli } from "../src/cli.mjs";
import { createClient } from "../src/index.mjs";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const HEAD2 = "c".repeat(40);
const MERGE = "d".repeat(40);
const START = "2026-01-01T12:00:00.000Z";
const CONTEXT = "conveyor/cleared";
const check = { __typename: "CheckRun", name: "Build", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "https://example.test/check" };
const clearance = (number) => ({ __typename: "StatusContext", context: `${CONTEXT}/pr-${number}/main`, state: "SUCCESS", createdAt: START });
const ok = (value) => ({ status: 0, stdout: typeof value === "string" ? value : JSON.stringify(value), stderr: "" });
const pull = (number = 1, headRefOid = HEAD) => ({
  number, title: `Pull request ${number}`, state: "OPEN", baseRefName: "main", baseRefOid: BASE, headRefOid, changedFiles: 1,
  isDraft: false, isCrossRepository: false, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", statusCheckRollup: [check, clearance(number)],
});
const page = (prs, { total = prs.length, cursor = null } = {}) => ok({ data: { repository: { pullRequests: {
  nodes: prs.map((pr) => ({ ...pr, statusCheckRollup: pr.statusCheckRollup === null ? null : {
    contexts: { nodes: pr.statusCheckRollup, totalCount: pr.statusCheckRollup.length },
  } })),
  totalCount: total, pageInfo: { hasNextPage: cursor !== null, endCursor: cursor },
} } } });

const fixture = (t, options = {}) => {
  const cwd = mkdtempSync(join(tmpdir(), "conveyor-client-"));
  const dir = join(cwd, ".git");
  mkdirSync(dir);
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const model = { prs: [pull()], calls: [], writes: [], time: Date.parse(START), viewer: 100, cleared: true, stale: new Set(), paths: new Map() };
  const find = (number) => model.prs.find((pr) => pr.number === Number(number));
  const auth = () => model.prs.map((pr) => ({ context: `${CONTEXT}/pr-${pr.number}/main`, state: "success", creator: { id: 100 } }));
  const run = (argv, context) => {
    model.calls.push(argv);
    const override = model.override?.(argv);
    if (override) return override;
    const [cmd, group, verb, arg] = argv;
    if (cmd === "git") {
      if (argv.includes("--show-toplevel")) return ok(cwd);
      if (argv.includes("--git-common-dir")) return ok(dir);
      if (group === "remote") return ok("https://github.com/example/widgets.git");
      if (argv.includes("--abbrev-ref")) return ok("main");
      if (argv.includes("--porcelain")) return ok("");
      if (argv.at(-1) === "HEAD") return ok(BASE);
    }
    if (cmd === "gh") assert.equal(context.env.GH_REPO, "github.com/example/widgets");
    if (group === "--version") return ok("gh version");
    if (group === "run" && verb === "list") return ok([{ status: "completed", conclusion: "success", headSha: BASE }]);
    if (group === "pr" && verb === "list") return ok([]);
    if (group === "pr" && verb === "view") return find(arg) ? ok(find(arg)) : { status: 1, stderr: "HTTP 404" };
    if (group === "api") {
      if (verb === "graphql") return page(model.prs.filter((pr) => pr.state === "OPEN"));
      if (verb === "user") return ok({ id: model.viewer });
      if (verb.endsWith("/commits/main")) return ok(BASE);
      if (verb.includes("/compare/")) return ok(model.stale.has(/compare\/(\w+)\.\.\./.exec(verb)[1]) ? 1 : 0);
      if (verb.includes("/statuses?")) return ok(model.cleared ? auth() : []);
      if (verb.includes("/rules/branches/")) return ok([{ type: "required_status_checks", parameters: {
        strict_required_status_checks_policy: true, required_status_checks: [{ context: "Build" }],
      } }]);
      if (verb.includes("/git/trees/")) return ok([false, []]);
      if (verb.includes("/files?")) {
        const pr = find(/pulls\/(\d+)\/files/.exec(verb)[1]);
        return ok([{ filename: model.paths.get(pr.number) ?? "src/file.mjs", sha: MERGE, status: "modified",
          contents_url: `https://api.github.com/repos/example/widgets/contents/file?ref=${pr.headRefOid}` }]);
      }
      if (verb === "--method") {
        model.writes.push(argv);
        if (model.onWrite) return model.onWrite(argv);
        if (argv.includes("POST")) model.cleared = true;
        return ok({});
      }
    }
    assert.fail(`unexpected command: ${argv.join(" ")}`);
  };
  const client = createClient({ cwd, config: { clearancePublisherId: 100, ...options.config }, ...options.hooks },
    { run, clock: () => new Date(model.time) });
  return { client, model, dir, statePath: join(dir, "conveyor.json") };
};

const value = (result) => {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
};

test("empty and paused queues are complete, and paused queue still describes PRs", async (t) => {
  const f = fixture(t);
  const paused = value(await f.client.queue());
  assert.equal(paused.complete, true);
  assert.equal(paused.nextAction, null);
  assert.equal(paused.nextActionKnown, true);
  assert.equal(paused.entries[0].state, "ready");
  assert.ok(formatQueue(paused).includes("Conveyor is paused. Next action: none."));
  f.model.prs = [];
  const empty = value(await f.client.queue());
  assert.deepEqual(empty.entries, []);
  assert.ok(formatQueue(empty).includes("No open pull requests target main."));
  assert.deepEqual(readdirSync(f.dir), []);
});

test("pagination retains known entries when a later page is rate limited", async (t) => {
  const f = fixture(t);
  value(await f.client.resume());
  f.model.override = (argv) => argv[2] === "graphql" && (argv.includes("cursor=second")
    ? { status: 1, stderr: "HTTP 429 rate limited\nRetry-After: 60\nprivate diagnostic" }
    : page(f.model.prs, { total: 2, cursor: "second" }));
  const result = value(await f.client.queue());
  assert.equal(result.complete, false);
  assert.equal(result.nextActionKnown, false);
  assert.deepEqual(result.entries.map((entry) => entry.number), [1]);
  assert.deepEqual(result.globalBlockers[0], { code: "rate_limited", message: "GitHub rate limited this request.", retryAt: "2026-01-01T12:01:00.000Z" });
  assert.ok(formatQueue(result).join("\n").includes("Next action: unknown."));
  assert.equal(f.model.writes.length, 0);
  assert.equal((await f.client.tick()).error.code, "rate_limited");
  assert.equal(f.model.writes.length, 0);
});

test("queue, explain and preview share ranking and never write", async (t) => {
  const f = fixture(t, { config: { autoUpdate: true } });
  f.model.prs.push(pull(2, HEAD2), { ...pull(3, "e".repeat(40)), title: "A very long title".repeat(10), statusCheckRollup: [{ ...check, status: "QUEUED", conclusion: null }] });
  f.model.stale.add(HEAD);
  value(await f.client.resume());
  const before = readdirSync(f.dir);
  const snapshot = value(await f.client.queue());
  assert.deepEqual(snapshot, value(await f.client.preview()));
  assert.deepEqual(snapshot.nextAction, { kind: "merge", number: 2, headSha: HEAD2 });
  assert.deepEqual(snapshot.entries.map((entry) => [entry.number, entry.state, entry.position]), [[2, "ready", 1], [1, "ready", 2], [3, "waiting", null]]);
  const explained = value(await f.client.explain({ number: 2 }));
  assert.deepEqual(explained.entry, snapshot.entries[0]);
  assert.deepEqual(explained.nextAction, snapshot.nextAction);
  assert.equal(explained.checks[0].url, "https://example.test/check");
  const text = formatQueue(snapshot, 36).join("\n");
  assert.match(text, /NEXT\s+#2/u);
  assert.match(text, /WAITING\s+#3/u);
  assert.match(text, /Wait for the checks to finish/u);
  assert.deepEqual(readdirSync(f.dir), before);
  assert.equal(f.model.writes.length, 0);
});

test("holds require separate approval and an unconfirmed write is journaled", async (t) => {
  const f = fixture(t);
  f.model.prs.push(pull(2, HEAD2));
  f.model.paths.set(1, "migrations/change.sql");
  value(await f.client.resume());
  const preview = value(await f.client.preview());
  assert.equal(preview.nextAction.number, 2);
  assert.equal(preview.entries[1].reasons[0].code, "hold_approval_required");
  assert.deepEqual(value(await f.client.explain({ number: 1 })).holds, ["migrations"]);
  f.model.onWrite = () => {
    assert.equal(JSON.parse(readFileSync(f.statePath)).operation.head, HEAD2);
    f.model.override = (argv) => argv[1] === "pr" && argv[2] === "view" ? { status: 1, stderr: "HTTP 502" } : null;
    return { status: 1, stderr: "timeout" };
  };
  const outcome = value(await f.client.tick());
  assert.equal(outcome.kind, "unknown");
  assert.deepEqual(outcome.action, preview.nextAction);
  assert.equal(f.model.writes.length, 1);
  await f.client.tick();
  assert.equal(f.model.writes.length, 1);
  assert.equal(value(await f.client.status()).operation.headSha, HEAD2);
});

test("clearance is pinned and idempotent, consent expires, and a veto runs only before a write", async (t) => {
  const policyCalls = [];
  const f = fixture(t, { hooks: { policy: (input) => { policyCalls.push(input); return false; } } });
  f.model.cleared = false;
  assert.equal((await f.client.clear({ number: 1, headSha: HEAD2 })).error.code, "head_changed");
  f.model.viewer = 200;
  assert.equal((await f.client.clear({ number: 1, headSha: HEAD })).error.code, "insufficient_permission");
  f.model.viewer = 100;
  assert.equal(value(await f.client.clear({ number: 1, headSha: HEAD })).kind, "cleared");
  assert.equal(value(await f.client.clear({ number: 1, headSha: HEAD })).kind, "already_cleared");
  assert.equal(f.model.writes.length, 1);
  const consent = value(await f.client.resume());
  assert.equal(consent.changed, true);
  assert.deepEqual(value(await f.client.resume()), { ...consent, changed: false });
  assert.equal(value(await f.client.preview()).nextAction.kind, "merge");
  assert.equal(policyCalls.length, 0);
  assert.equal(value(await f.client.tick()).reason.code, "policy_veto");
  assert.deepEqual(policyCalls[0].action, { kind: "merge", number: 1, headSha: HEAD });
  assert.equal(f.model.writes.length, 1);
  f.model.time += 8 * 3_600_000;
  assert.equal(value(await f.client.tick()).reason.code, "paused");
  assert.equal(value(await f.client.pause()).changed, false);
});

test("clearance belongs to the reviewed PR and base, and a lost response is reconciled", async (t) => {
  const f = fixture(t);
  f.model.prs[0] = { ...pull(2, HEAD), statusCheckRollup: [check, clearance(1), { ...clearance(2), context: `${CONTEXT}/pr-2/other` }] };
  let statuses = [
    { context: clearance(1).context, state: "success", creator: { id: 100 } },
    { context: `${CONTEXT}/pr-2/other`, state: "success", creator: { id: 100 } },
  ];
  f.model.override = (argv) => argv[2]?.includes("/statuses?") ? ok(statuses) : null;
  value(await f.client.resume());
  assert.equal(value(await f.client.preview()).nextAction, null);
  const target = { number: 2, headSha: HEAD };
  f.model.onWrite = () => ok({});
  assert.equal(value(await f.client.clear(target)).kind, "unknown");
  f.model.onWrite = (argv) => {
    assert.ok(argv.includes(`context=${clearance(2).context}`));
    statuses = [{ context: clearance(2).context, state: "success", creator: { id: 100 } }, ...statuses];
    return { status: 1, stderr: "timeout" };
  };
  assert.equal(value(await f.client.clear(target)).kind, "cleared");
  assert.equal(value(await f.client.clear(target)).kind, "already_cleared");
  assert.equal(f.model.writes.length, 2);
});

test("a short changed-file list cannot rule out a hold", async (t) => {
  const f = fixture(t);
  f.model.prs[0].changedFiles = 2;
  value(await f.client.resume());
  const preview = value(await f.client.preview());
  assert.equal(preview.nextActionKnown, false);
  assert.equal(preview.entries[0].reasons[0].code, "holds_unavailable");
  assert.equal((await f.client.tick()).error.code, "data_unavailable");
  assert.equal(f.model.writes.length, 0);
});

test("a pause cannot succeed while a tick owns consent", async (t) => {
  const f = fixture(t);
  value(await f.client.resume());
  let pause;
  f.model.onWrite = () => {
    pause = f.client.pause();
    return { status: 1, stderr: "timeout" };
  };
  assert.equal(value(await f.client.tick()).kind, "unknown");
  assert.equal((await pause).error.code, "operator_locked");
  assert.equal(value(await f.client.pause()).changed, true);
  assert.equal(value(await f.client.tick()).reason.code, "paused");
  assert.equal(f.model.writes.length, 1);
});

test("preview and tick skip definite candidate blockers", async (t) => {
  const f = fixture(t);
  f.model.prs.push({ ...pull(2, HEAD2), mergeStateStatus: "BLOCKED" }, pull(3, "e".repeat(40)));
  f.model.override = (argv) => argv[2]?.includes(`/${HEAD}/statuses?`) ?
    ok([{ context: clearance(1).context, state: "success", creator: { id: 99 } }]) : null;
  value(await f.client.resume());
  const preview = value(await f.client.preview());
  assert.equal(preview.nextAction.number, 3);
  assert.equal(preview.entries.find(({ number }) => number === 1).reasons[0].code, "trusted_clearance_required");
  assert.equal(preview.entries.find(({ number }) => number === 2).reasons[0].code, "github_not_ready");
  assert.deepEqual(value(await f.client.tick()).action, preview.nextAction);
  assert.equal(f.model.writes.length, 1);
});

test("a partial lower queue cannot erase a verified next merge", async (t) => {
  const f = fixture(t);
  const prs = Array.from({ length: 65 }, (_, index) => pull(index + 1));
  f.model.prs = prs;
  f.model.override = (argv) => {
    if (argv[2] !== "graphql") return null;
    const start = Number(argv.find((arg) => arg.startsWith("cursor="))?.split("=")[1] ?? 0);
    const end = start + 25;
    return page(prs.slice(start, end), { total: prs.length, cursor: end < prs.length ? String(end) : null });
  };
  value(await f.client.resume());
  const preview = value(await f.client.preview());
  assert.equal(preview.complete, false);
  assert.equal(preview.nextActionKnown, true);
  assert.equal(preview.nextAction.number, 1);
  assert.deepEqual(value(await f.client.tick()).action, preview.nextAction);
});

test("a failed update comparison retains the journal and an undelivered legacy alarm", async (t) => {
  const f = fixture(t, { config: { autoUpdate: true } });
  const queued = { key: "legacy", line: "A pending alarm" };
  writeFileSync(f.statePath, JSON.stringify({ outbox: [queued] }));
  f.model.stale.add(HEAD);
  value(await f.client.resume());
  f.model.onWrite = () => {
    f.model.prs[0] = { ...pull(1, HEAD2), statusCheckRollup: [check] };
    f.model.override = (argv) => argv[2]?.includes(`/compare/${HEAD2}...`) ? { status: 1, stderr: "HTTP 502" } : null;
    return { status: 1, stderr: "timeout" };
  };
  assert.equal(value(await f.client.tick()).kind, "unknown");
  const saved = JSON.parse(readFileSync(f.statePath, "utf8"));
  assert.equal(saved.operation.head, HEAD);
  assert.deepEqual(saved.outbox[0], queued);
  assert.equal(saved.lastSuccessfulTickAt, undefined);
  await f.client.tick();
  assert.equal(f.model.writes.length, 1);
  f.model.override = null;
  await f.client.tick();
  assert.equal(value(await f.client.status()).lastAction.newHeadSha, HEAD2);
});

test("CLI JSON is one result with stable exit codes and sanitized read errors", async (t) => {
  const f = fixture(t);
  const cli = async (argv, client = f.client) => {
    let stdout = "";
    let stderr = "";
    const code = await runCli(argv, { clientFactory: () => client, stdout: { write: (line) => { stdout += line; } },
      stderr: { isTTY: true, write: (line) => { stderr += line; } } });
    return { stdout, stderr, code };
  };
  const json = await cli(["tick", "--dry-run", "--json"]);
  assert.equal(json.code, 0);
  assert.match(json.stderr, /Previewing the next action/u);
  assert.equal(json.stdout.trimEnd().split("\n").length, 1);
  assert.deepEqual(JSON.parse(json.stdout), await f.client.preview());
  const tick = await cli(["tick"], { tick: async () => ({ ok: true, value: { kind: "idle", reason: { code: "no_action", message: "No action." } } }) });
  assert.equal(tick.code, 0);
  assert.match(tick.stderr, /Running one worker tick/u);
  assert.equal((await cli(["tick", "--dryrun"])).code, 2);
  const unknown = await cli(["tick", "--json"], { tick: async () => ({ ok: true, value: { kind: "unknown" } }) });
  assert.equal(unknown.code, 3);
  const unknownClear = await cli(["clear", "1", HEAD], { clear: async () => ({
    ok: true, value: { kind: "unknown", reason: { message: "Clearance unconfirmed." } },
  }) });
  assert.equal(unknownClear.code, 3);
  assert.equal(unknownClear.stdout.trim(), "Clearance unconfirmed.");
  f.model.override = (argv) => argv[2] === "graphql" && { status: 1, stderr: "HTTP 401: private diagnostic" };
  const offline = await cli(["queue", "--json"]);
  assert.equal(offline.code, 1);
  assert.equal(JSON.parse(offline.stdout).error.code, "missing_auth");
  assert.ok(!offline.stdout.includes("private diagnostic"));
  writeFileSync(f.statePath, "{broken");
  const broken = await cli(["status", "--json"]);
  assert.equal(broken.code, 1);
  assert.equal(JSON.parse(broken.stdout).value.stateHealth, "corrupt");
  assert.equal(readFileSync(f.statePath, "utf8"), "{broken");
});
