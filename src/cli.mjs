import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { createClient, EXIT_CODES } from "./client.mjs";
import { isSha } from "./github.mjs";

const HELP = `Usage: conveyor <command> [--json] [--config PATH]

  queue                   Show open PRs in scheduling order
  explain <pr>            Explain checks, holds and next steps for one PR
  status                  Show worker health, consent and last action
  doctor                  Check the checkout, GitHub access and branch protection
  report [--days N]        Summarize merge times over 1–90 days (default 7)
  tick --dry-run           Preview the next action without writing
  tick                    Run one worker tick
  clear <pr> <sha>         Record clearance for the full reviewed head SHA
  pause                   Pause the local worker
  resume                  Grant expiring consent to the local worker
  --help                  Show this help
  --version               Show the installed package version

Configuration: .conveyor.json at the checkout root, or --config PATH.
The worker starts paused. Resume requires a trusted clearance publisher.
Queue/explain read for up to 15 seconds and at most 160 commands, including
up to 200 open PRs and 99 check contexts per PR. Partial results say so.
JSON writes one Result to stdout. Exit codes: 0 result, 1 operation error
or unhealthy diagnostics, 2 usage, 3 a write could not be confirmed.`;

const visible = (value) => String(value ?? "").replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, " ");
const chars = (value) => Array.from(visible(value));
const trim = (value, limit) => {
  const text = chars(value);
  return text.length <= limit ? text.join("") : `${text.slice(0, limit - 1).join("")}…`;
};
const wrap = (value, width) => {
  const lines = [];
  let line = "";
  for (const word of visible(value).trim().split(/\s+/u)) {
    if (line && chars(line).length + chars(word).length + 1 > width) {
      lines.push(line);
      line = "";
    }
    const pieces = chars(word);
    while (pieces.length > width) lines.push(pieces.splice(0, width).join(""));
    line += `${line ? " " : ""}${pieces.join("")}`;
  }
  return line ? [...lines, line] : lines;
};

export const formatQueue = (snapshot, columns = 80) => {
  const { entries, base, nextAction, nextActionKnown, globalBlockers } = snapshot;
  const width = Math.max(24, columns);
  const count = entries.length;
  const lines = [`${visible(snapshot.repo)} → ${snapshot.complete ? count : `${count} observed`} open PR${count === 1 && snapshot.complete ? "" : "s"}`];
  const paused = globalBlockers.some(({ code }) => code === "paused");
  if (paused) lines.push("Conveyor is paused. Next action: none.");
  if (!snapshot.complete) {
    const detail = globalBlockers.find(({ code }) => code !== "paused")?.message;
    const action = !nextActionKnown ? "unknown" : nextAction ? `${nextAction.kind} #${nextAction.number}` : "none";
    lines.push(`Queue incomplete. ${detail ? `${visible(detail)} ` : ""}Next action: ${action}.`);
  } else if (count === 0) lines.push(`No open pull requests target ${visible(base)}.`);
  if (!paused && snapshot.complete) {
    for (const block of globalBlockers) lines.push(visible(block.message));
  }
  for (const reason of globalBlockers) if (reason.retryAt) lines.push(`Retry after ${visible(reason.retryAt)}.`);
  for (const entry of entries) {
    const label = nextAction?.number === entry.number ? "NEXT" : entry.state.toUpperCase();
    const prefix = `${label.padEnd(8)} #${entry.number}  `;
    const space = Math.max(10, width - prefix.length);
    const title = trim(entry.title, width >= 60 ? Math.min(24, space) : space);
    const details = entry.reasons.map(({ message }) => visible(message)).join(" ");
    if (width >= 60) {
      const titleColumn = 26;
      const indented = " ".repeat(prefix.length + titleColumn);
      const [first = "", ...more] = wrap(details, Math.max(10, width - indented.length));
      lines.push(`${prefix}${title}${" ".repeat(Math.max(1, titleColumn - chars(title).length))}${first}`, ...more.map((line) => `${indented}${line}`));
    } else {
      lines.push(`${prefix}${title}`, ...wrap(details, Math.max(10, width - 2)).map((line) => `  ${line}`));
    }
  }
  if (count > 0) {
    const example = entries.find((entry) => entry.state === "blocked") ?? entries[0];
    lines.push("", `Run conveyor explain ${example.number} for details.`);
  }
  return lines;
};

const formatExplain = ({ entry, checks, checksComplete, holds, nextStep, globalBlockers }) => [
  `#${entry.number} ${visible(entry.title)} · ${entry.state}`,
  `Head ${entry.headSha}`,
  ...entry.reasons.map(({ message }) => visible(message)),
  ...checks.map((check) => `  ${visible(check.name)} · ${check.state ?? "unknown"}${check.url ? ` · ${visible(check.url)}` : ""}`),
  ...(!checksComplete ? ["Check details are incomplete."] : []),
  ...(holds.length ? [`Holds: ${visible(holds.join(", "))}`] : []),
  ...globalBlockers.map(({ message }) => visible(message)),
  `Next: ${visible(nextStep.message)}`,
];

const format = (command, value, columns) => {
  switch (command) {
    case "queue":
    case "preview": return formatQueue(value, columns);
    case "explain": return formatExplain(value);
    case "doctor": return value.checks.map(({ ok, message }) => `${ok ? "OK" : "FIX"}  ${visible(message)}`);
    case "status": return [
      `${visible(value.repo)} → ${visible(value.base)}`,
      `Journal: ${value.stateHealth}`,
      `Last tick: ${value.lastTickAt ?? "none"} · last successful tick: ${value.lastSuccessfulTickAt ?? "none"}`,
      ...(value.lastAction ? [`Last action: ${value.lastAction.kind} #${value.lastAction.number} at ${value.lastAction.at}`] : []),
      ...(value.operation ? [`In flight: ${value.operation.kind} #${value.operation.number} since ${value.operation.since}`] : []),
      ...(value.nextRetryAt ? [`Next retry: ${value.nextRetryAt}`] : []),
      ...(value.consentUntil ? [`Consent until ${value.consentUntil}`] : []),
      ...value.globalBlockers.map(({ message }) => visible(message)),
    ];
    case "report": return [
      `${value.days} day window · ${value.merged} merged · ${value.unclocked} without a clearance time`,
      ...(value.p50Minutes === null ? [] : [`p50 ${Math.round(value.p50Minutes)}m · p90 ${Math.round(value.p90Minutes)}m`]),
      ...(!value.complete ? ["Report reached the 200 merge limit. Counts and timings are partial."] : []),
    ];
    case "tick": {
      if (value.kind === "merged" || value.kind === "updated") return [`#${value.number} ${value.kind}.`];
      return [visible(value.reason.message)];
    }
    case "clear": return value.kind === "unknown" ? [visible(value.reason.message)] :
      [`#${value.number} ${value.kind === "cleared" ? "cleared" : "already cleared"} at ${value.headSha}.`];
    case "pause": return ["Conveyor is paused."];
    case "resume": return [`Conveyor consent expires at ${value.consentUntil}.`];
    default: throw new Error("Unsupported CLI operation");
  }
};

const integer = (value) => typeof value === "string" && /^[1-9]\d*$/u.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
const commands = new Set(["queue", "explain", "status", "doctor", "report", "tick", "clear", "pause", "resume"]);

export const runCli = async (argv, {
  clientFactory = createClient,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) => {
  const emit = (stream, text) => stream.write(`${text}\n`);
  const usage = (message) => {
    if (argv.includes("--json")) emit(stdout, JSON.stringify({ ok: false, error: { code: "invalid_input", message } }));
    else emit(stderr, `${message}\nRun conveyor --help.`);
    return EXIT_CODES.usage;
  };
  let parsed;
  try {
    parsed = parseArgs({
      args: argv, allowPositionals: true, options: {
        json: { type: "boolean" }, config: { type: "string" }, days: { type: "string" },
        "dry-run": { type: "boolean" }, help: { type: "boolean", short: "h" }, version: { type: "boolean", short: "v" },
      },
    });
  } catch {
    return usage("Unknown option or missing option value.");
  }
  const { values, positionals: [command, ...args] } = parsed;
  if (values.help || (command === undefined && argv.length === 0)) {
    emit(stdout, HELP);
    return EXIT_CODES.ok;
  }
  if (values.version && argv.length === 1) {
    emit(stdout, JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
    return EXIT_CODES.ok;
  }
  if (!commands.has(command) || values.version || (values["dry-run"] && command !== "tick") ||
    (values.days !== undefined && command !== "report")) return usage("Invalid command or option.");
  let input;
  if (command === "explain" || command === "clear") {
    const [pr, headSha] = args;
    const number = integer(pr);
    if (!number || args.length !== (command === "clear" ? 2 : 1) || (command === "clear" && !isSha(headSha))) {
      return usage(command === "clear" ? "Use conveyor clear <pr> <full reviewed SHA>." : "Use conveyor explain <pr>.");
    }
    input = { number, ...(headSha ? { headSha } : {}) };
  } else if (args.length > 0) return usage("Unexpected argument.");
  if (command === "report" && values.days !== undefined) {
    const days = integer(values.days);
    if (!days || days > 90) return usage("--days takes an integer from 1 to 90.");
    input = { days };
  }
  const action = values["dry-run"] ? "preview" : command;
  const progress = {
    queue: "Reading GitHub…", preview: "Previewing the next action…", explain: "Reading GitHub…",
    status: "Checking worker status…", doctor: "Checking Conveyor setup…", report: "Reading merge history…",
    tick: "Running one worker tick…", clear: "Recording clearance for the reviewed head…",
  }[action];
  if (stderr.isTTY && progress) emit(stderr, progress);
  const client = clientFactory({ configPath: values.config });
  const result = await client[action](input);
  if (values.json) emit(stdout, JSON.stringify(result));
  else if (result.ok) for (const line of format(action, result.value, stdout.columns)) emit(stdout, line);
  else {
    const prefix = ["queue", "preview"].includes(action) ? "Queue unavailable. " : "";
    emit(stderr, `${prefix}${visible(result.error.message)}`);
    if (result.error.retryAt) emit(stderr, `Retry after ${visible(result.error.retryAt)}.`);
  }
  if (!result.ok) return result.error.code === "invalid_input" ? EXIT_CODES.usage : EXIT_CODES.error;
  if (action === "tick" && result.value.kind === "unknown") return EXIT_CODES.unknownWrite;
  if (action === "clear" && result.value.kind === "unknown") return EXIT_CODES.unknownWrite;
  if ((action === "doctor" && !result.value.healthy) || (action === "status" && result.value.stateHealth === "corrupt")) return EXIT_CODES.error;
  return EXIT_CODES.ok;
};
