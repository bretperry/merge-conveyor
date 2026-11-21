// The worker event feed: what a tick appends, what it never contains, and that it cannot fail a tick.
// Run: node --test test/events.test.mjs.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createEvents, EVENTS_MAX_BYTES, readEvents } from "../src/events.mjs";
import { createClient } from "../src/index.mjs";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const MERGE = "d".repeat(40);
const START = "2026-01-01T12:00:00.000Z";
const TITLE = "Secret roadmap title";
const ok = (value) => ({ status: 0, stdout: typeof value === "string" ? value : JSON.stringify(value), stderr: "" });
const check = { __typename: "CheckRun", name: "Build", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "https://example.test/check" };
const cleared = { __typename: "StatusContext", context: `conveyor/cleared/pr-1/${createHash("sha256").update("main").digest("hex").slice(0, 32)}`, state: "SUCCESS", createdAt: START };

const fixture = (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "conveyor-events-"));
  const dir = join(cwd, ".git");
  mkdirSync(dir);
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const pr = { number: 1, title: TITLE, state: "OPEN", baseRefName: "main", baseRefOid: BASE, headRefOid: HEAD, changedFiles: 1,
    isDraft: false, isCrossRepository: false, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", statusCheckRollup: [check, cleared] };
  const run = (argv) => {
    const [cmd, group, verb, arg] = argv;
    if (cmd === "git") {
      if (argv.includes("--show-toplevel")) return ok(cwd);
      if (argv.includes("--git-common-dir")) return ok(dir);
      if (group === "remote") return ok("https://github.com/example/widgets.git");
      if (argv.includes("--abbrev-ref")) return ok("main");
      if (argv.includes("--name-only") || argv.includes("--stage") || argv.includes("--porcelain")) return ok("");
      if (argv.at(-1) === "HEAD") return ok(BASE);
    }
    if (group === "--version") return ok("gh version");
    if (group === "run" && verb === "list") return ok([{ status: "completed", conclusion: "success", headSha: BASE }]);
    if (group === "pr" && verb === "list") return ok([]);
    if (group === "pr" && verb === "view") return arg === "1" ? ok(pr) : { status: 1, stderr: "HTTP 404" };
    if (group === "api") {
      if (verb === "graphql") {
        const nodes = pr.state === "OPEN" ? [{ ...pr, statusCheckRollup: { contexts: { nodes: pr.statusCheckRollup, totalCount: 2 } } }] : [];
        return ok({ data: { repository: { pullRequests: { nodes, totalCount: nodes.length, pageInfo: { hasNextPage: false, endCursor: null } } } } });
      }
      if (verb === "user") return ok({ id: 100 });
      if (verb.endsWith("/commits/main")) return ok(BASE);
      if (verb.includes("?per_page=1&page=1") && verb.includes("/compare/")) return ok({ base: BASE, files: [{ filename: "src/file.mjs", sha: MERGE,
        status: "modified", contents_url: `https://api.github.com/repos/example/widgets/contents/file?ref=${HEAD}` }] });
      if (verb.includes("/compare/")) return ok(0);
      if (verb.includes("/statuses?")) return ok([{ context: cleared.context, state: "success", creator: { id: 100 } }]);
      if (verb.includes("/rules/branches/")) return ok([{ type: "required_status_checks", parameters: {
        strict_required_status_checks_policy: true, required_status_checks: [{ context: "Build" }] } }]);
      if (verb.includes("/git/trees/")) return ok([false, []]);
      if (verb === "--method") {
        Object.assign(pr, { state: "MERGED", mergeCommit: { oid: MERGE }, mergedAt: START });
        return ok({});
      }
    }
    assert.fail(`unexpected command: ${argv.join(" ")}`);
  };
  const client = createClient({ cwd, config: { clearancePublisherId: 100 } }, { run, clock: () => new Date(START) });
  return { client, path: join(dir, "conveyor.events.ndjson") };
};

test("a merging tick appends start, intent and outcome, and no PR text", async (t) => {
  const f = fixture(t);
  assert.equal((await f.client.resume()).ok, true);
  const preview = await f.client.preview();
  assert.equal(preview.value.nextAction?.number, 1, JSON.stringify(preview));
  assert.equal(existsSync(f.path), false, "preview must not write events");
  const outcome = await f.client.tick();
  assert.equal(outcome.value.kind, "merged", JSON.stringify(outcome));
  const events = readEvents(f.path);
  assert.deepEqual(events.map((event) => event.type), ["tick_started", "intent_journaled", "tick_finished"]);
  assert.deepEqual(events[1].action, { kind: "merge", number: 1, headSha: HEAD });
  assert.equal(events[1].baseSha, BASE);
  assert.equal(events[2].outcome, "merged");
  assert.equal(events[2].result.mergeSha, MERGE);
  assert.ok(events[2].commands > 0);
  assert.ok(events.every((event) => event.schemaVersion === 1 && event.at === START));
  assert.doesNotMatch(readFileSync(f.path, "utf8"), /Secret|example\/widgets/);
});

test("a paused tick records a blocked outcome with its stable code", async (t) => {
  const f = fixture(t);
  assert.equal((await f.client.tick()).value.kind, "blocked");
  const events = readEvents(f.path);
  assert.deepEqual(events.map((event) => event.type), ["tick_started", "tick_finished"]);
  assert.deepEqual([events[1].outcome, events[1].code], ["blocked", "paused"]);
});

test("an unwritable event feed never fails a tick", async (t) => {
  const f = fixture(t);
  mkdirSync(f.path);
  assert.equal((await f.client.resume()).ok, true);
  assert.equal((await f.client.tick()).value.kind, "merged");
});

test("the feed rotates once and readers skip torn lines", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "conveyor-events-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "events.ndjson");
  const emit = createEvents(path, () => new Date(START));
  assert.equal(readEvents(path).length, 0);
  assert.equal(emit("old"), true);
  appendFileSync(path, "x".repeat(EVENTS_MAX_BYTES));
  appendFileSync(path, '\n{"schemaVersion":1,"type":"to');
  assert.equal(emit("new", { number: 7 }), true);
  assert.deepEqual(readEvents(path).map((event) => event.type), ["old", "new"]);
  assert.deepEqual(readEvents(path, 1).map((event) => event.number), [7]);
  assert.ok(readFileSync(path, "utf8").length < 200);
});
