// The watch view: how entries become crates, what each frame shows, and when the command refuses to start.
// Run: node --test test/watch.test.mjs.
import assert from "node:assert/strict";
import { test } from "node:test";

import { runCli } from "../src/cli.mjs";
import { advance, createView, frameToText, ingest, MIN_SIZE, renderFrame } from "../src/watch.mjs";

const HEAD = "b".repeat(40);
const reason = (code, message = code) => ({ code, message });
const entry = (number, state, code, title = `Pull request ${number}`) => ({ number, title, url: `https://example.test/${number}`, headSha: HEAD, state, position: null, reasons: [reason(code)] });
const snapshot = (entries, extra = {}) => ({ schemaVersion: 1, repo: "example/widgets", base: "main", observedAt: "2026-01-01T12:00:00.000Z", complete: true,
  globalBlockers: [], entries, nextAction: null, nextActionKnown: true, ...extra });
const status = (extra = {}) => ({ schemaVersion: 1, repo: "example/widgets", base: "main", stateHealth: "ok", lastTickAt: null, lastSuccessfulTickAt: null,
  lastAction: null, nextRetryAt: null, operation: null, consentUntil: null, globalBlockers: [], ...extra });
const view = (data, at = 1_000_000) => {
  const v = createView({ now: () => at });
  ingest(v, data);
  return v;
};
const text = (v, cols = 120, rows = 34) => {
  for (let i = 0; i < 90; i++) advance(v, 1 / 15, { wide: true, cx: cols - 20, cy: 7, beltEnd: cols - 32, xDock: cols - 40, xForge: Math.round((cols - 32) * 0.46), xSync: Math.round((cols - 32) * 0.7), xClear: Math.round((cols - 32) * 0.24) });
  return frameToText(renderFrame(v, cols, rows));
};

test("entries map to queue states by their stable reason codes", () => {
  const entries = [
    entry(1, "ready", "checks_passed"), entry(2, "waiting", "checks_pending"), entry(3, "blocked", "hold_approval_required"),
    entry(4, "blocked", "checks_failed"), entry(5, "waiting", "clearance_required"), entry(6, "waiting", "branch_update_ready"),
  ];
  entries[0].position = 1;
  const v = view({ snapshot: snapshot(entries, { nextAction: { kind: "merge", number: 1, headSha: HEAD } }), status: status() });
  assert.deepEqual([...v.prs.values()].map((pr) => pr.kind), ["ready", "running", "held", "failing", "reviews", "ready"]);
  assert.equal(v.prs.get(6).stale, true);
  const out = text(v).join("\n");
  assert.match(out, /NEXT\s+#1/);
  assert.match(out, /BLOCKED\s+#3/);
  assert.match(out, /acme|example\/widgets → main/);
});

test("paused, empty, partial and corrupt states are labelled", () => {
  const paused = text(view({ snapshot: snapshot([], { globalBlockers: [reason("paused", "Conveyor is paused.")] }), status: status() })).join("\n");
  assert.match(paused, /PAUSED/);
  assert.match(paused, /No open pull requests target main\./);
  const partial = text(view({ snapshot: snapshot([entry(1, "unknown", "pr_evidence_unavailable")], { complete: false, nextActionKnown: false }), status: status() })).join("\n");
  assert.match(partial, /Queue incomplete\. Next action unknown\./);
  const corrupt = text(view({ snapshot: snapshot([]), status: status({ stateHealth: "corrupt" }) })).join("\n");
  assert.match(corrupt, /CORRUPT/);
  assert.match(corrupt, /Journal corrupt\. Writes blocked\./);
});

test("the event feed drives the log, the in-flight merge and the tick estimate", () => {
  const at = Date.parse("2026-01-01T12:10:00.000Z");
  const events = [0, 5, 10].flatMap((minute) => [
    { schemaVersion: 1, at: new Date(Date.parse("2026-01-01T12:00:00.000Z") + minute * 60000).toISOString(), type: "tick_started" },
    { schemaVersion: 1, at: new Date(Date.parse("2026-01-01T12:00:00.000Z") + minute * 60000 + 2000).toISOString(), type: "tick_finished", outcome: "idle", code: "no_action", commands: 31 },
  ]);
  const v = view({ snapshot: snapshot([entry(1, "ready", "checks_passed")]), status: status(), events }, at + 30_000);
  const out = text(v).join("\n");
  assert.match(out, /tick idle · no_action · 31 commands/);
  assert.match(out, /next 04:3\d/);
  const flying = view({ snapshot: snapshot([entry(1, "ready", "checks_passed")]), status: status({ operation: { kind: "merge", number: 1, headSha: HEAD, since: "2026-01-01T12:00:00.000Z" } }) });
  assert.match(text(flying).join("\n"), /MERGING/);
});

test("a merged tick that arrives after the first read triggers the burst once", () => {
  const v = view({ events: [{ schemaVersion: 1, at: "2026-01-01T12:00:00.000Z", type: "tick_started" }] });
  assert.equal(v.shock, -1);
  const merged = { schemaVersion: 1, at: "2026-01-01T12:05:00.000Z", type: "tick_finished", outcome: "merged", commands: 40, result: { kind: "merged", number: 1, mergeSha: "d".repeat(40) } };
  ingest(v, { events: [...v.events, merged] });
  assert.equal(v.shock, 0);
  assert.match(v.log.at(-1).text, /merged #1 → ddddddd/);
});

test("frames fit the terminal at every supported size and never carry control text", () => {
  const nasty = snapshot([entry(1, "ready", "checks_passed", "Title\u001b[2J\u0007with‮control")]);
  for (const [cols, rows] of [[MIN_SIZE.cols, MIN_SIZE.rows], [33, 39], [60, 26], [84, 32], [90, 39], [120, 34], [200, 60]]) {
    const frame = renderFrame(view({ snapshot: nasty, status: status() }), cols, rows);
    assert.equal(frame.ch.length, cols * rows);
    assert.equal(frame.ch.every((c) => Array.from(c).length === 1 && !/[\p{Cc}\p{Cf}]/u.test(c)), true, `${cols}x${rows}`);
  }
});

test("watch refuses scripts, extra arguments and small terminals before reading anything", async () => {
  const lines = [];
  const stream = (props) => ({ ...props, write: (line) => lines.push(String(line)) });
  const touched = [];
  const clientFactory = () => { touched.push(true); return {}; };
  assert.equal(await runCli(["watch"], { clientFactory, stdout: stream({ isTTY: false }), stderr: stream({}) }), 2);
  assert.match(lines.join(""), /watch needs a terminal/);
  assert.equal(await runCli(["watch", "--json"], { clientFactory, stdout: stream({ isTTY: true }), stderr: stream({}) }), 2);
  assert.equal(await runCli(["watch", "7"], { clientFactory, stdout: stream({ isTTY: true }), stderr: stream({}) }), 2);
  assert.equal(await runCli(["queue", "--calm"], { clientFactory, stdout: stream({ isTTY: true }), stderr: stream({}) }), 2);
  assert.deepEqual(touched, []);
});

test("a draft or unclear PR reads BLOCKED, as `queue` says", () => {
  const v = view({ snapshot: snapshot([entry(9, "blocked", "draft"), entry(10, "blocked", "clearance_required"), entry(11, "waiting", "clearance_required")]), status: status() });
  const out = text(v).join("\n");
  assert.match(out, /BLOCKED\s+#9/);
  assert.match(out, /BLOCKED\s+#10/);
  assert.match(out, /WAITING\s+#11/);
  assert.match(out, /2 blocked/);
});

test("crates that would queue past the intake edge are counted, not clipped", () => {
  const entries = [9, 10, 12, 14, 15, 16].map((n) => entry(n, "waiting", "clearance_required"));
  const out = text(view({ snapshot: snapshot(entries), status: status() }), 120, 34).join("\n");
  assert.match(out, /\+\d+ more/);
  assert.doesNotMatch(out, /^\d{1,2} │/mu);
});

test("a short wide pane keeps telemetry above the event log", () => {
  const out = text(view({ snapshot: snapshot([entry(1, "waiting", "checks_pending")]), status: status() }), 120, 28);
  const log = out.findIndex((line) => line.includes("EVENT LOG"));
  assert.ok(log > 0);
  assert.ok(out.slice(log + 1).every((line) => !/│|journal|grant|base ●/u.test(line)), out.slice(log + 1).join("\n"));
  assert.ok(out.some((line) => line.includes("api")));
});
