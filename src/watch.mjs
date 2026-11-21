// Live terminal view of one worker: the pipeline as a machine, the ranked queue, telemetry and the event log.
// Used by: the conveyor watch command and the package tests.
// Exports: createView, renderFrame, runWatch, MIN_SIZE.
// Read-only: it shows what queue, status and the event feed report and never ticks, clears, pauses or resumes.
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { readEvents } from "./events.mjs";

export const MIN_SIZE = { cols: 30, rows: 26 };
const WIDE = { cols: 84, rows: 26 };
const REFRESH_MS = 15_000;
const REPORT_MS = 300_000;
const READ_LIMIT = 160;

const C = {
  bg: [7, 6, 13], bar: [20, 16, 36], row: [16, 26, 30], faint: [46, 42, 70], dim: [96, 92, 128], text: [216, 212, 236],
  white: [255, 255, 255], cyan: [0, 229, 255], mag: [255, 46, 136], yel: [255, 212, 0], org: [255, 122, 0],
  vio: [122, 60, 255], grn: [61, 255, 162], red: [255, 72, 72], ink: [10, 8, 18],
};
const lerp = (a, b, k) => { k = Math.max(0, Math.min(1, k)); return [a[0] + (b[0] - a[0]) * k | 0, a[1] + (b[1] - a[1]) * k | 0, a[2] + (b[2] - a[2]) * k | 0]; };
const hash = (x, y) => { let h = Math.imul(x * 374761393 + y * 668265263 | 0, 1274126177); h ^= h >>> 13; return ((h >>> 0) % 1000) / 1000; };
const same = (a, b) => a === b || (a[0] === b[0] && a[1] === b[1] && a[2] === b[2]);
// Control and format characters in PR text could move the cursor or hide content.
const clean = (value) => String(value ?? "").replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, " ");
const fit = (value, n) => {
  const text = Array.from(clean(value));
  return text.length > n ? `${text.slice(0, Math.max(0, n - 1)).join("")}…` : text.join("").padEnd(n);
};
const clock = (seconds) => { const s = Math.max(0, Math.ceil(seconds)); return `${String(s / 60 | 0).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; };
const ago = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`; };
const short = (sha) => (typeof sha === "string" ? sha.slice(0, 7) : "?");

const KIND = { reviews: C.dim, running: C.cyan, ready: C.grn, failing: C.red, held: C.mag, merging: C.yel };
// Crate kind from the entry's first stable reason code. Unknown codes fall back to the entry state.
const kindOf = (entry) => {
  const codes = entry.reasons.map(({ code }) => code);
  const has = (...wanted) => codes.some((code) => wanted.includes(code));
  if (has("hold_approval_required")) return "held";
  if (has("checks_failed", "merge_conflict")) return "failing";
  if (has("checks_pending", "checks_missing", "base_settling")) return "running";
  if (has("clearance_required", "trusted_clearance_required", "draft", "head_changed")) return "reviews";
  if (entry.state === "ready") return "ready";
  if (entry.state === "waiting") return has("branch_update_required", "branch_update_ready", "retry_wait") ? "ready" : "running";
  return entry.state === "blocked" ? "failing" : "reviews";
};
const isStale = (entry) => entry.reasons.some(({ code }) => /^branch_update|^retry_wait$/u.test(code));

const median = (values) => (values.length ? values.toSorted((a, b) => a - b)[values.length >> 1] : null);

export const createView = ({ now = () => Date.now() } = {}) => ({
  now, t0: now(), t: 0, calm: false, snapshot: null, status: null, merged: null, events: [], lastRead: null, readError: null,
  prs: new Map(), log: [], seenEvents: 0, primed: false,
  energy: 0, shock: -1, packet: -1, spin: 0, flow: Array.from({ length: 24 }, () => 0),
});

// Fold fresh reads into the view. Any argument may be omitted when its read failed.
export const ingest = (view, { snapshot, status, merged, events, error }) => {
  if (snapshot) view.snapshot = snapshot;
  if (status) view.status = status;
  if (merged !== undefined && merged !== null) view.merged = merged;
  if (error !== undefined) view.readError = error;
  if (snapshot) view.lastRead = view.now();
  if (events) {
    view.events = events;
    const fresh = view.primed ? events.slice(view.seenEvents) : [];
    view.seenEvents = events.length;
    view.primed = true;
    for (const event of fresh) {
      view.log.push({ at: event.at, text: describe(event), color: eventColor(event) });
      if (event.type === "tick_finished" && event.outcome === "merged") { view.shock = 0; view.packet = 0; view.energy = 1; }
    }
    if (!fresh.length && view.log.length === 0) {
      for (const event of events.slice(-5)) view.log.push({ at: event.at, text: describe(event), color: eventColor(event) });
    }
    view.log = view.log.slice(-40);
    view.flow = events.filter((event) => event.type === "tick_finished" && Number.isFinite(event.commands)).slice(-24).map((event) => event.commands);
    while (view.flow.length < 24) view.flow.unshift(0);
  }
  if (snapshot) {
    const live = new Set();
    for (const entry of snapshot.entries) {
      live.add(entry.number);
      const next = view.prs.get(entry.number) ?? { n: entry.number, chip: undefined };
      Object.assign(next, { title: entry.title, head: entry.headSha, kind: kindOf(entry), state: entry.state, stale: isStale(entry), reasons: entry.reasons, position: entry.position });
      view.prs.set(entry.number, next);
    }
    for (const number of view.prs.keys()) if (!live.has(number)) view.prs.delete(number);
  }
};

const describe = (event) => {
  const who = event.action ? `#${event.action.number}` : "";
  switch (event.type) {
    case "tick_started": return "tick started";
    case "intent_journaled": return `journal intent → ${event.action.kind} ${who} @${short(event.action.headSha)}`;
    case "tick_finished": {
      if (event.outcome === "merged") return `merged #${event.result?.number} → ${short(event.result?.mergeSha)} · ${event.commands} commands`;
      if (event.outcome === "updated") return `updated #${event.result?.number} → ${short(event.result?.newHeadSha)}`;
      return `tick ${event.outcome}${event.code ? ` · ${event.code}` : ""} · ${event.commands} commands`;
    }
    default: return event.type;
  }
};
const eventColor = (event) => event.type === "intent_journaled" ? C.cyan
  : event.type === "tick_finished" ? ({ merged: C.grn, updated: C.yel, unknown: C.org, error: C.red, blocked: C.yel }[event.outcome] ?? C.dim) : C.dim;

// What the worker is doing now, from the last events and the journal's in-flight operation.
const activity = (view) => {
  const last = view.events.at(-1);
  const op = view.status?.operation;
  const scanning = last?.type === "tick_started";
  const flying = !!op || last?.type === "intent_journaled";
  const starts = view.events.filter((event) => event.type === "tick_started").map((event) => Date.parse(event.at));
  const gaps = starts.slice(1).map((at, i) => at - starts[i]).slice(-5);
  const interval = median(gaps.filter((gap) => gap > 0));
  const lastStart = starts.at(-1) ?? (view.status?.lastTickAt ? Date.parse(view.status.lastTickAt) : null);
  const age = lastStart === null ? null : view.now() - lastStart;
  return { scanning: scanning && !flying, flying, op: op ?? (last?.type === "intent_journaled" ? { kind: last.action.kind, number: last.action.number } : null),
    interval, age, next: interval && age !== null ? Math.max(0, (interval - age) / 1000) : null, commands: [...view.events].reverse().find((event) => event.type === "tick_finished")?.commands ?? 0 };
};

const derive = (view) => {
  const snapshot = view.snapshot;
  const blockers = snapshot?.globalBlockers ?? [];
  const act = activity(view);
  const crates = [...view.prs.values()].map((pr) => pr.n === act.op?.number && act.flying && act.op.kind === "merge" ? { ...pr, kind: "merging" } : pr);
  const next = snapshot?.nextAction?.number;
  return {
    snapshot, act, crates, next,
    paused: blockers.some(({ code }) => code === "paused"),
    settling: blockers.some(({ code }) => code === "base_settling"),
    partial: snapshot ? !snapshot.complete : false,
    corrupt: view.status?.stateHealth === "corrupt" || blockers.some(({ code }) => code === "state_corrupt"),
    unconfirmed: blockers.some(({ code }) => code === "write_unconfirmed") || view.events.at(-1)?.outcome === "unknown",
    consentMs: view.status?.consentUntil ? Date.parse(view.status.consentUntil) - view.now() : null,
  };
};

// Advance the animation clock and the easing of every crate. Called once per frame.
export const advance = (view, dt, layout) => {
  view.t = (view.now() - view.t0) / 1000;
  const model = derive(view);
  const merging = model.act.flying && model.act.op?.kind === "merge";
  view.energy = merging ? Math.min(1, view.energy + dt * 0.5) : Math.max(0, view.energy - dt * 0.35);
  if (view.shock >= 0 && (view.shock += dt * 1.1) > 1) view.shock = -1;
  if (view.packet >= 0 && (view.packet += dt * 1.6) > 1) view.packet = -1;
  view.spin += dt * (model.paused ? 0.15 : merging ? 5.5 : view.calm ? 0.4 : model.crates.some((p) => p.kind === "ready") ? 1.3 : 0.6);
  const order = { merging: 0, ready: 1, running: 3, reviews: 4 };
  const rank = (p) => order[p.kind] + (p.kind === "ready" && p.stale ? 1 : 0);
  const stop = { ready: layout.xDock, running: layout.xForge, reviews: layout.xClear };
  const lane = model.crates.filter((p) => p.kind in order).toSorted((a, b) => rank(a) - rank(b) || a.n - b.n);
  let prev = Infinity;
  for (const p of lane) {
    if (p.kind === "merging") { p.tx = layout.cx - 3; continue; }
    p.tx = Math.min(p.kind === "ready" && p.stale ? layout.xSync : stop[p.kind], prev - 8);
    prev = p.tx;
    // A crate that would queue past the intake edge waits out of sight; the view counts it as "+N".
    p.hidden = p.tx < 1;
    if (p.hidden) p.tx = -8;
  }
  model.crates.filter((p) => !(p.kind in order)).forEach((p, i) => { p.tx = layout.xDock - 4 - i * 8; });
  for (const p of model.crates) {
    const parked = !(p.kind in order);
    const home = view.prs.get(p.n);
    if (home.x === undefined) { home.x = -8; home.y = parked ? 4 : 8; }
    const ty = parked || p.tx < home.x - 3 ? 4 : 8;
    home.x += (p.tx - home.x) * Math.min(1, dt * (p.kind === "merging" ? 1.6 : 3));
    home.y += (ty - home.y) * Math.min(1, dt * 5);
    p.x = home.x; p.y = home.y;
  }
};

const layoutFor = (cols, rows) => {
  if (cols < WIDE.cols || rows < WIDE.rows) return { wide: false, cx: cols >> 1, cy: 7, beltEnd: cols, xDock: 60, xForge: 30, xSync: 45, xClear: 15, x0: cols, logTop: rows - 4 };
  const cx = cols - 20, beltEnd = cx - 12;
  return { wide: true, cx, cy: 7, beltEnd, xDock: beltEnd - 8, xForge: Math.round(beltEnd * 0.46), xSync: Math.round(beltEnd * 0.7), xClear: Math.round(beltEnd * 0.24), x0: cols - 32, logTop: rows - 7 };
};

// Pure: the same view and size always draw the same cells. Returns { cols, rows, ch, fg, bg }.
export const renderFrame = (view, cols, rows) => {
  const W = cols, H = rows;
  const ch = new Array(W * H).fill(" "), fg = new Array(W * H).fill(C.text), bg = new Array(W * H).fill(C.bg);
  const put = (x, y, text, color = C.text, back) => {
    x = Math.round(x); y = Math.round(y);
    if (y < 0 || y >= H) return;
    for (const c of Array.from(String(text))) {
      if (x >= 0 && x < W) { const i = y * W + x; ch[i] = c; fg[i] = color; if (back) bg[i] = back; }
      x++;
    }
  };
  const G = layoutFor(W, H);
  const calm = view.calm;
  const m = derive(view);
  advance(view, 0, G);
  const t = calm ? 0 : view.t;
  const act = m.act;
  const merging = act.flying && act.op?.kind === "merge";
  const hot = view.energy;
  const baseColor = m.settling ? C.org : C.grn;

  // krackle field
  for (let y = 2; y <= 12; y++) for (let x = 0; x < W; x++) {
    const d = Math.hypot((x - G.cx) / 2.3, y - G.cy);
    const n = Math.sin(x * 0.21 + t * 0.35) * Math.sin(y * 0.8 - t * 0.22) + Math.sin((x * 0.5 + y * 1.7) * 0.33 + t * 0.18);
    const v = n * 0.5 + hash(x, y) * 0.9 + hot * Math.max(0, 1 - d / 15) * 1.5 + 0.3 * Math.max(0, 1 - d / 8);
    if (v < 1.22) continue;
    const k = (v - 1.22) / 1.2;
    put(x, y, k > 0.55 ? "●" : k > 0.22 ? "•" : "·", k > 0.5 ? lerp(C.mag, C.yel, (k - 0.5) * 2) : lerp(C.faint, C.mag, k * 1.6));
  }
  if (view.shock >= 0 && !calm) {
    const ry = 2 + view.shock * 7, rx = ry * 2.5;
    for (let i = 0; i < 140; i++) {
      const a = (i / 140) * Math.PI * 2, x = Math.round(G.cx + rx * Math.cos(a)), y = Math.round(G.cy + ry * Math.sin(a));
      if (y >= 2 && y <= 12) put(x, y, hash(i, 7) > 0.5 ? "●" : "•", lerp(C.yel, C.mag, view.shock));
    }
  }
  if (act.scanning && !calm) {
    const x = Math.round(((view.t * 0.7) % 1) * (G.beltEnd - 1));
    for (let y = 4; y <= 10; y++) { put(x, y, "│", C.cyan); put(x - 1, y, "┊", lerp(C.bg, C.cyan, 0.45)); put(x - 2, y, "┊", lerp(C.bg, C.cyan, 0.2)); }
  }

  if (G.wide) {
    const label = (x, s, c = C.dim) => put(Math.max(1, x - (s.length >> 1)), 2, s, c);
    const roomy = W >= 110;
    put(1, 2, "INTAKE", C.dim); label(G.xClear + 3, roomy ? "CLEARANCE" : "CLEAR"); label(G.xForge + 3, roomy ? "CI FORGE" : "FORGE");
    label(G.xSync + 3, roomy ? "SYNC BAY" : "SYNC"); label(G.xDock + 3, roomy ? "READY DOCK" : "DOCK"); label(G.cx, "MERGE CORE", merging ? C.yel : C.text);
    for (let x = 0; x < G.beltEnd; x++) put(x, 3, x % 8 === 4 ? "┬" : "─", C.faint);
    if (roomy) put(G.xForge - 16, 3, " HOLDING RAIL ", C.faint);
    for (const x of [G.xClear + 7, G.xForge + 7, G.xSync + 7, G.beltEnd - 1]) for (let y = 4; y <= 10; y++) put(x, y, "┊", C.faint);
    const roll = m.paused || calm ? 0 : Math.floor(view.t * 9);
    for (let x = 0; x < G.beltEnd; x++) {
      put(x, 11, ((x - roll) % 4 + 4) % 4 === 0 ? "┳" : "━", lerp(C.vio, C.cyan, x / G.beltEnd));
      if (x % 6 === 3) put(x, 12, "◴◷◶◵"[(roll >> 1) % 4], C.dim);
    }
    const over = m.crates.filter((p) => p.hidden).length;
    if (over) put(1, 6, `+${over} more`, C.dim);
    for (const p of m.crates.toSorted((a, b) => b.y - a.y)) {
      if (p.x === undefined || p.hidden) continue;
      const x = Math.round(p.x), y = Math.round(p.y);
      const c = p.kind === "ready" && p.stale ? C.yel : p.kind === "merging" ? lerp(C.yel, C.white, 0.5 + 0.5 * Math.sin(view.t * 18)) : KIND[p.kind];
      const sweep = Math.floor(view.t * 3) % 5;
      const pips = Array.from({ length: 5 }, (_, i) => (i === sweep || i === (sweep + 1) % 5 ? "▮" : "▯")).join("");
      const foot = { reviews: "──?──", running: pips, ready: p.stale ? "──↻──" : "──✓──", failing: "──✕──", held: "HOLD─", merging: "─▶▶▶─" }[p.kind];
      if (y < 7) for (let r = 4; r < y; r++) put(x + 3, r, "│", C.faint);
      put(x, y, "╭─────╮", c); put(x, y + 1, "│     │", c); put(x + 1, y + 1, `#${p.n}`.padStart(4), C.white); put(x, y + 2, `╰${foot}╯`, c);
      if (p.kind === "running" && y === 8 && !calm) for (let i = 0; i < 7; i++) {
        const h = hash(x + i, Math.floor(view.t * 14));
        if (h > 0.35) put(x + i, 7, i % 2 ? "╲" : "╱", h > 0.8 ? C.white : C.yel);
      }
    }
  } else {
    for (let x = 0; x < W; x++) put(x, 16, ((x - (m.paused || calm ? 0 : Math.floor(view.t * 9))) % 4 + 4) % 4 === 0 ? "┳" : "━", lerp(C.vio, C.cyan, x / W));
    m.crates.toSorted((a, b) => Number(a.kind === "failing" || a.kind === "held") - Number(b.kind === "failing" || b.kind === "held") || b.tx - a.tx).forEach((p, i) => {
      const target = W - 6 - i * 6;
      p.chip = target;
      const color = p.kind === "ready" && p.stale ? C.yel : KIND[p.kind];
      put(target, 15, `#${p.n}`.padStart(4).padEnd(5), C.ink, color);
    });
  }

  // merge core
  const { cx, cy } = G;
  const a1 = m.paused ? C.dim : m.settling ? C.org : C.cyan, a0 = m.paused ? C.faint : C.vio;
  const ring = (rx, ry, lobes, phase, from, to) => {
    for (let i = 0; i < 160; i++) {
      const a = (i / 160) * Math.PI * 2, k = 0.5 + 0.5 * Math.cos(a * lobes - phase);
      put(cx + rx * Math.cos(a), cy + ry * Math.sin(a), "░▒▓█"[Math.min(3, k * 4 | 0)], lerp(lerp(from, to, k), C.white, hot * k * 0.8));
    }
  };
  ring(11, 4.4, 3, view.spin, a0, a1);
  ring(6, 2.4, 2, -view.spin * 1.7, m.paused ? C.faint : C.org, m.paused ? C.dim : C.yel);
  const word = m.corrupt ? "CORRUPT" : m.unconfirmed ? "UNCONFIRMED" : m.paused ? "PAUSED" : merging ? "MERGING" : act.flying ? "UPDATE" : m.settling ? "BASE CI" : m.next ? "ARMED" : "IDLE";
  const wordColor = m.corrupt ? C.red : m.unconfirmed ? C.org : m.paused || merging ? C.yel : m.settling ? C.org : C.grn;
  const who = act.op ? `#${act.op.number}` : "◆";
  for (let y = cy - 1; y <= cy + 1; y++) put(cx - 5, y, " ".repeat(11));
  put(cx - (who.length >> 1), cy, who, merging ? C.white : C.text);
  put(cx - (word.length >> 1), cy + 1, word, wordColor);
  if (W - cx > 20) {
    const dash = Math.floor(view.t * 10);
    for (let x = cx + 12; x < W - 2; x++) put(x, cy, !m.settling ? "━" : (x + dash) % 3 ? "╍" : " ", baseColor);
    put(W - 2, cy, "▶", baseColor);
    if (view.packet >= 0) put(cx + 12 + view.packet * (W - 3 - cx - 12), cy, "◆", C.white);
    put(W - 6, cy - 1, "main", C.text);
  }

  // header
  for (let x = 0; x < W; x++) {
    put(x, 0, " ", C.text, C.bar);
    const pulse = Math.max(0, 1 - Math.abs(((view.t * 30) % (W + 40)) - x) / 10);
    put(x, 1, "━", lerp(lerp(C.vio, C.mag, 0.5 + 0.5 * Math.sin(x * 0.12 - t * 1.5)), C.yel, calm ? 0 : pulse));
  }
  put(0, 0, " ◢◤ CONVEYOR ", C.ink, C.yel);
  const repo = m.snapshot ? `${clean(m.snapshot.repo)} → ${clean(m.snapshot.base)}` : "connecting…";
  if (G.wide) put(14, 0, repo, C.text, C.bar);
  const pill = m.paused ? " ■ PAUSED " : " ● RUNNING ";
  const pillAt = G.wide ? 14 + repo.length + 2 : W - pill.length;
  put(pillAt, 0, pill, C.ink, m.paused ? C.yel : C.grn);
  const doing = act.scanning ? "reading GitHub" : act.flying ? `${act.op?.kind ?? "write"} in flight` : act.next !== null ? `next ${clock(act.next)}` : act.age !== null ? `last ${ago(act.age)} ago` : "no ticks yet";
  const consent = m.consentMs !== null && m.consentMs > 0 ? ` · consent ${m.consentMs / 3600000 | 0}h${String((m.consentMs % 3600000) / 60000 | 0).padStart(2, "0")}m` : "";
  if (G.wide) {
    const right = `${doing}${W >= 104 ? consent : ""} `;
    put(W - right.length, 0, right, act.scanning || act.flying ? C.cyan : C.dim, C.bar);
  }

  // queue rows
  const rowsData = m.crates.map((p) => {
    const reason = p.reasons[0]?.code ?? "";
    let tag, color, text, eta = "—";
    if (p.kind === "merging") [tag, color, text, eta] = ["MERGING", C.yel, "in flight · intent journaled", "now"];
    else if (p.n === m.next) [tag, color, text, eta] = ["NEXT", C.grn, reason, act.next !== null ? clock(act.next) : "next tick"];
    else if (p.kind === "ready" && p.stale) [tag, color, text, eta] = ["WAITING", C.yel, reason, "+update"];
    else if (p.kind === "ready") [tag, color, text, eta] = ["READY", C.grn, reason, p.position ? `#${p.position} in line` : "—"];
    else if (p.kind === "running") [tag, color, text] = ["WAITING", C.cyan, p.reasons[0]?.message ?? "checks pending"];
    else if (p.kind === "reviews") [tag, color, text] = [p.state === "blocked" ? "BLOCKED" : "WAITING", C.dim, p.reasons[0]?.message ?? "waiting for clearance"];
    else if (p.kind === "failing") [tag, color, text] = ["BLOCKED", C.red, p.reasons[0]?.message ?? "blocked"];
    else [tag, color, text] = ["BLOCKED", C.mag, p.reasons[0]?.message ?? reason];
    return { p, tag, color, text, eta };
  });
  const weight = { MERGING: 0, NEXT: 1, READY: 2, WAITING: 3, BLOCKED: 4 };
  rowsData.sort((a, b) => weight[a.tag] - weight[b.tag] || (a.p.position ?? 99) - (b.p.position ?? 99) || a.p.n - b.p.n);
  const count = (tag) => rowsData.filter((r) => r.tag === tag).length;
  const qTop = G.wide ? 13 : 18;
  const width = G.wide ? G.x0 - 4 : W;
  put(G.wide ? 1 : 0, qTop, "▌", C.yel); put(G.wide ? 2 : 1, qTop, "QUEUE", C.white);
  const total = m.snapshot ? `${rowsData.length}${m.partial ? "+" : ""} open · ${count("NEXT") + count("READY")} ready · ${count("WAITING")} waiting · ${count("BLOCKED")} blocked` : "reading GitHub…";
  put(G.wide ? 9 : 7, qTop, fit(total, width - 8), C.dim);
  if (m.snapshot && rowsData.length === 0) put(G.wide ? 1 : 0, qTop + 2, fit(`No open pull requests target ${clean(m.snapshot.base)}.`, width), C.dim);
  const room = G.logTop - qTop - 3;
  if (G.wide) {
    const showTitle = width >= 76, showEta = width >= 54;
    const wTitle = showTitle ? Math.min(34, width - 24 - 30) : 0;
    const xTitle = 17, xReason = xTitle + (showTitle ? wTitle + 1 : 0), wReason = Math.max(8, Math.min(44, width - xReason - (showEta ? 9 : 1)));
    const xEta = xReason + wReason + 1;
    put(1, qTop + 1, "STATE", C.faint); put(11, qTop + 1, "PR", C.faint); if (showTitle) put(xTitle, qTop + 1, "TITLE", C.faint);
    put(xReason, qTop + 1, "REASON", C.faint); if (showEta) put(xEta, qTop + 1, "ETA", C.faint);
    rowsData.slice(0, room).forEach(({ p, tag, color, text, eta }, i) => {
      const y = qTop + 2 + i, hi = tag === "NEXT" || tag === "MERGING" ? C.row : undefined;
      if (hi) put(1, y, " ".repeat(width), C.text, hi);
      put(1, y, `${tag === "NEXT" ? (Math.floor(view.t * 2) % 2 ? "▶" : "▷") : tag === "MERGING" ? "◆" : " "}${tag}`.padEnd(9), color, hi);
      put(11, y, `#${p.n}`.padEnd(6), C.white, hi);
      if (showTitle) put(xTitle, y, fit(p.title, wTitle), tag === "BLOCKED" ? C.dim : C.text, hi);
      put(xReason, y, fit(text, wReason), color, hi);
      if (showEta) put(xEta, y, fit(eta, 8), C.dim, hi);
    });
    for (let y = qTop; y < G.logTop; y++) put(G.x0 - 2, y, "│", C.faint);
    // telemetry
    const x = G.x0;
    put(x, qTop, "▌", C.mag); put(x + 1, qTop, "TELEMETRY", C.white);
    const digits = String(view.merged ?? "–");
    const DIGITS = ["111101101101111", "010110010010111", "111001111100111", "111001111001111", "101101111001001", "111100111001111", "111100111101111", "111001001001001", "111101111101111", "111101111001111"];
    [...digits].forEach((d, i) => {
      for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
        if (!(d in DIGITS)) { if (r === 1) put(x + i * 7 + c * 2, qTop + 3, "▬▬", C.dim); continue; }
        const top = DIGITS[d][r * 6 + c] === "1", bottom = DIGITS[d][r * 6 + 3 + c] === "1";
        put(x + i * 7 + c * 2, qTop + 2 + r, (top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ").repeat(2), hot > 0.05 ? lerp(C.yel, C.white, hot) : C.yel);
      }
    });
    put(x + 15, qTop + 2, "MERGED", C.white); put(x + 15, qTop + 3, "last 7d", C.dim);
    // Rows below the digits, most useful first when the pane is short: the sparkline is the first to go.
    let ty = qTop + 6;
    const room2 = G.logTop - ty;
    if (room2 >= 6) {
      const top = Math.max(4, ...view.flow);
      put(x, ty, "cmds", C.dim);
      view.flow.forEach((v, i) => put(x + 6 + i, ty, "▁▂▃▄▅▆▇█"[Math.min(7, (v / top) * 8 | 0)], lerp(C.vio, C.cyan, i / view.flow.length)));
      ty++;
    }
    const gauge = (name, k, tail, color) => {
      const y = ty++;
      if (y >= G.logTop) return;
      put(x, y, name.padEnd(5), C.dim); put(x + 5, y, "▕", C.faint);
      for (let i = 0; i < 12; i++) put(x + 6 + i, y, i < k * 12 ? "█" : "░", i < k * 12 ? color : C.faint);
      put(x + 18, y, "▏", C.faint); put(x + 20, y, tail, C.text);
    };
    const line = (name, text, color) => { const y = ty++; if (y < G.logTop) { put(x, y, name, C.dim); put(x + 6, y, text, color); } };
    gauge("tick", act.scanning || act.flying ? 1 : act.interval && act.age !== null ? Math.min(1, act.age / act.interval) : 0, act.scanning ? "scan" : act.flying ? "write" : act.next !== null ? clock(act.next) : "—", C.cyan);
    gauge("api", act.commands / READ_LIMIT, `${String(act.commands).padStart(3, "0")}/${READ_LIMIT}`, C.mag);
    line("base", m.settling ? `${"◴◷◶◵"[Math.floor(view.t * 6) % 4]} checks running` : m.snapshot ? "● settled" : "…", m.settling ? C.org : C.grn);
    line("state", `journal ${view.status?.stateHealth ?? "?"}${act.scanning || act.flying ? " · lock held" : ""}`, m.corrupt ? C.red : C.text);
    line("grant", m.paused ? "paused · no consent" : m.consentMs !== null && m.consentMs > 0 ? `consent ${m.consentMs / 3600000 | 0}h${String((m.consentMs % 3600000) / 60000 | 0).padStart(2, "0")}m` : "unknown", m.paused ? C.yel : C.text);
  } else {
    put(1, 13, fit(`${doing}`, W - 2), act.scanning || act.flying ? C.cyan : C.dim);
    put(1, 14, fit(`merged ${view.merged ?? "–"} · base ${m.settling ? "checking" : "settled"} · cmds ${act.commands}`, W - 2), m.settling ? C.org : C.dim);
    rowsData.slice(0, room + 1).forEach(({ p, tag, color, text }, i) => {
      const y = qTop + 1 + i, hi = tag === "NEXT" || tag === "MERGING" ? C.row : undefined;
      if (hi) put(0, y, " ".repeat(W), C.text, hi);
      put(0, y, `${tag === "NEXT" ? "▶" : tag === "MERGING" ? "◆" : " "}${tag}`.padEnd(9), color, hi);
      put(9, y, `#${p.n}`.padEnd(5), C.white, hi);
      put(14, y, fit(text, W - 14), color, hi);
    });
  }

  // banners that outrank the machine
  const banner = m.corrupt ? ["Journal corrupt. Writes blocked.", C.red] : m.unconfirmed ? ["Write unconfirmed. See operator recovery.", C.org]
    : view.readError ? [`Read failed: ${clean(view.readError)}`, C.org] : m.partial ? ["Queue incomplete. Next action unknown.", C.yel] : null;
  if (banner) { put(0, H - 2 - (G.wide ? 6 : 3), fit(` ${banner[0]}`, W), C.ink, banner[1]); }

  // log + keys
  if (G.wide) {
    put(1, G.logTop, "▌", C.cyan); put(2, G.logTop, "EVENT LOG", C.white);
    for (let x = 13; x < W - 1; x++) put(x, G.logTop, "─", C.faint);
  }
  const lines = view.log.slice(G.wide ? -5 : -2);
  lines.forEach((line, i) => {
    const age = (lines.length - 1 - i) / 6;
    const y = G.logTop + 1 + i;
    if (G.wide) { put(1, y, String(line.at ?? "").slice(11, 19), lerp(C.dim, C.bg, age)); put(11, y, fit(line.text, W - 13), lerp(line.color, C.bg, age)); }
    else put(0, y, fit(line.text, W), lerp(line.color, C.bg, age));
  });
  put(0, H - 1, fit(` q quit  c ${calm ? "full motion" : "calm"}`, W), C.dim);
  return { cols: W, rows: H, ch, fg, bg };
};

export const frameToText = ({ cols, rows, ch }) => Array.from({ length: rows }, (_, y) => ch.slice(y * cols, (y + 1) * cols).join("").trimEnd());

const ansi = ({ cols, rows, ch, fg, bg }) => {
  let out = "\x1b[H", lf = null, lb = null;
  for (let y = 0; y < rows; y++) {
    out += `\x1b[${y + 1};1H`;
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x;
      if (!lb || !same(lb, bg[i])) { lb = bg[i]; out += `\x1b[48;2;${lb[0]};${lb[1]};${lb[2]}m`; }
      if (ch[i] !== " " && (!lf || !same(lf, fg[i]))) { lf = fg[i]; out += `\x1b[38;2;${lf[0]};${lf[1]};${lf[2]}m`; }
      out += ch[i];
    }
  }
  return out;
};

const BIN = fileURLToPath(new URL("./bin.mjs", import.meta.url));
// Reads run in child processes so a slow GitHub call never stalls the animation.
const readJson = (args, cwd) => new Promise((resolve) => {
  const child = spawn(process.execPath, [BIN, ...args, "--json"], { cwd, stdio: ["ignore", "pipe", "ignore"], timeout: 30_000 });
  let out = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  child.on("error", () => resolve(null));
  child.on("close", () => { try { resolve(JSON.parse(out)); } catch { resolve(null); } });
});

export const runWatch = async ({ client, configPath, cwd = process.cwd(), stdout = process.stdout, stdin = process.stdin, calm = false }) => {
  const view = createView();
  view.calm = calm;
  const located = await client.events({ limit: 0 });
  if (!located.ok) return located;
  const feed = located.value.path;
  const base = configPath ? ["--config", configPath] : [];
  const refresh = async () => {
    const [queue, status] = await Promise.all([readJson(["queue", ...base], cwd), readJson(["status", ...base], cwd)]);
    ingest(view, { snapshot: queue?.ok ? queue.value : undefined, status: status?.ok ? status.value : undefined,
      error: queue?.ok ? null : (queue?.error?.message ?? "could not reach Conveyor") });
  };
  const refreshReport = async () => {
    const report = await readJson(["report", "--days", "7", ...base], cwd);
    if (report?.ok) ingest(view, { merged: report.value.merged });
  };
  const timers = [];
  const done = new Promise((resolve) => {
    const leave = () => { timers.forEach(clearInterval); stdout.write("\x1b[0m\x1b[?25h\x1b[?1049l"); stdin.setRawMode?.(false); stdin.pause(); resolve({ ok: true, value: null }); };
    stdout.write("\x1b[?1049h\x1b[?25l");
    stdin.setRawMode(true); stdin.resume();
    stdin.on("data", (data) => {
      const key = String(data);
      if (key === "q" || key === "\x03") leave();
      if (key === "c") view.calm = !view.calm;
    });
    process.once("SIGTERM", leave);
    let last = Date.now(), cols = 0, rows = 0, busy = false;
    timers.push(setInterval(() => ingest(view, { events: readEvents(feed, 200) ?? undefined }), 1000));
    timers.push(setInterval(async () => { if (!busy) { busy = true; await refresh(); busy = false; } }, REFRESH_MS));
    timers.push(setInterval(refreshReport, REPORT_MS));
    timers.push(setInterval(() => {
      if (stdout.columns < MIN_SIZE.cols || stdout.rows < MIN_SIZE.rows) {
        stdout.write(`\x1b[0m\x1b[2J\x1b[H needs ${MIN_SIZE.cols}×${MIN_SIZE.rows}; now ${stdout.columns}×${stdout.rows}. q quits.`);
        cols = 0; return;
      }
      if (stdout.columns !== cols || stdout.rows !== rows) { cols = stdout.columns; rows = stdout.rows; stdout.write("\x1b[0m\x1b[2J"); }
      const now = Date.now(), dt = Math.min(0.1, (now - last) / 1000); last = now;
      const frame = renderFrame(view, cols, rows);
      advance(view, dt, layoutFor(cols, rows));
      stdout.write(ansi(frame));
    }, 66));
    ingest(view, { events: readEvents(feed, 200) ?? [] });
    refresh().then(refreshReport);
  });
  return done;
};
