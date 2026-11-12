// Configured conveyor tick, clearance, status and reporting.
// Used by: the conveyor CLI and the package tests.
// Exports: createConveyor.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { checkRows, ciVerdict } from "./ci.mjs";
import { hasStrictChecks, isSha, MERGE_METHODS, mergePull, parseJson, readMerge, readPull, updatePull } from "./github.mjs";
import { readState, takeLock, writeState } from "./state.mjs";
import { candidateDecision, chooseAction, rankedCandidates } from "./policy.mjs";
import { isQueueRead } from "./queue-source.mjs";

const short = (sha) => (sha || "?").slice(0, 7);

// Nearest-rank percentile of a list of numbers.
const percentile = (values, p) => values.toSorted((a, b) => a - b)[Math.ceil((p / 100) * values.length) - 1];

const minutes = (value) => (value < 120 ? `${Math.round(value)}m` : `${(value / 60).toFixed(1)}h`);

const hourOf = (now) => now.toISOString().slice(0, 13);

// Read PR state and base when approved work needs checking. Null means the read failed;
// an unknown PR must not be treated as absent from the base.
const knownPrs = (work, run) => {
  if (work(new Map()).length === 0) return new Map();
  const result = run(["gh", "pr", "list", "--state", "all", "--limit", "1000", "--json", "number,state,baseRefName"]);
  const all = result.status === 0 ? parseJson(result.stdout) : null;
  return Array.isArray(all) ? new Map(all.map((pr) => [pr.number, { state: pr.state, base: pr.baseRefName }])) : null;
};

const ensure = (condition, field, expected) => {
  if (!condition) throw new TypeError(`Invalid conveyor config: ${field} must be ${expected}`);
};

// Fail before exposing operations: missing policy can suppress alarms or select undefined state files.
const validateConfig = (config) => {
  const object = (value, field) => ensure(value !== null && typeof value === "object" && !Array.isArray(value), field, "an object");
  const string = (value, field) => ensure(typeof value === "string" && value.trim().length > 0, field, "a nonempty string");

  object(config, "config");
  for (const field of ["base", "baseWorkflow", "switchVariable", "clearedContext", "stateName"]) string(config[field], field);
  ensure(config.stateName === basename(config.stateName) && !/[\\/]/.test(config.stateName), "stateName", "a filename stem");
  ensure(config.mergeMethod === undefined || MERGE_METHODS.includes(config.mergeMethod), "mergeMethod", "merge, squash, or rebase");
  ensure(config.autoUpdate === undefined || typeof config.autoUpdate === "boolean", "autoUpdate", "a boolean");
  ensure(config.clearancePublisherId === undefined || (Number.isSafeInteger(config.clearancePublisherId) && config.clearancePublisherId > 0), "clearancePublisherId", "a positive GitHub user ID");
  object(config.release, "release");
  string(config.release.branch, "release.branch");
  ensure(config.base !== config.release.branch, "base", "different from release.branch");
  object(config.ageAlarms, "ageAlarms");
  for (const field of ["pokeHours", "tellHours"]) {
    ensure(Number.isFinite(config.ageAlarms[field]) && config.ageAlarms[field] >= 0, `ageAlarms.${field}`, "a finite nonnegative number");
  }
  ensure(config.ageAlarms.tellHours > config.ageAlarms.pokeHours, "ageAlarms.tellHours", "greater than ageAlarms.pokeHours");
  object(config.adapters, "adapters");
  for (const field of ["approved", "changeDigest", "gitDir", "heldDigest", "readHeld", "activeUntil", "commando", "heldBy", "isGateContext", "wrangleMerge", "approvedWork", "approvalClock"]) {
    ensure(typeof config.adapters[field] === "function", `adapters.${field}`, "a function");
  }
  ensure(config.adapters.DOCS_ONLY instanceof RegExp, "adapters.DOCS_ONLY", "a RegExp");
};

export const createWorker = (config, runtime) => {
  validateConfig(config);
  const { approved, gitDir, heldDigest, readHeld, activeUntil, commando, heldBy, isGateContext, wrangleMerge, approvedWork, approvalClock } = config.adapters;
  const { pokeHours: APPROVED_POKE_HOURS, tellHours: APPROVED_TELL_HOURS } = config.ageAlarms;
  // Knobs. The commit status that says a head passed its reviews.
  const CLEARED_CONTEXT = config.clearedContext;
  // The off switch: a repo variable every tick reads first. A tick acts only when it reads exactly this value.
  const ENABLED_VARIABLE = config.switchVariable;
  const ENABLED_VALUE = "on";
  // The workflow whose last run on `dev` decides "dev green"; a project's deploys don't count.
  const DEV_WORKFLOW = config.baseWorkflow;
  const BASE_BRANCH = config.base;
  const SHIP_BRANCH = config.release.branch;
  const MERGE_METHOD = config.mergeMethod ?? "merge";
  const AUTO_UPDATE = config.autoUpdate ?? false;
  const CLEARANCE_PUBLISHER = config.clearancePublisherId;
  // How long before commando's end to warn.
  const COMMANDO_WARN_HOURS = 1;
  // A tick is checked as green first, so this only bounds a stale draft run; commando's own default is 55.
  const MERGE_WAIT_MINUTES = 10;
  // Time for the merged PR's `dev` run to register before the next merge reads "dev green".
  const DEV_SETTLE_MINUTES = 5;
  // A run in progress is normal; a `dev` not green for this long gets an alarm with its reason.
  const DEV_STUCK_MINUTES = 30;
  // A head whose merge attempt didn't land waits this long, so one stuck PR can't starve the others.
  const MERGE_RETRY_MINUTES = 30;
  // How long one PR's update may hold the queue: its head moving, then its CI finishing. Past it, an alarm and the queue goes on.
  const UPDATE_FLIGHT_MINUTES = 60;
  const LOCK_HUNG_MINUTES = 120; // Legacy export. A live worker now keeps its lock until exit.
  const REPORT_DAYS = 7;
  // Target timing from approval to the configured base.
  const TARGET_P50_MINUTES = 30;
  const TARGET_P90_MINUTES = 120;
  const HOOK_TIMEOUT_MS = 60_000;
  // Alarms kept for a down alarm command. A cap, because it could be down for weeks; each is in the log anyway.
  const OUTBOX_MAX = 50;
  // One git or gh call. A hung one would otherwise stop every later tick with no word to anyone.
  const RUN_TIMEOUT_MS = 120_000;
  // Long enough to outlast any head; only keeps the state file from growing forever.
  const STATE_KEEP_DAYS = 30;
  const LIST_LIMIT = "200";
  const STATE_NAME = `${config.stateName}.json`;
  const LOG_NAME = `${config.stateName}.log`;
  const LOCK_NAME = `${config.stateName}.lock`;
  // `tick`'s code once it has alarmed, so the shell wrapper only reports a tick that couldn't.
  const REPORTED = 3;

  const HOUR = 3600 * 1000;
  const MINUTE = 60 * 1000;

  const defaultRun = (argv, timeout = RUN_TIMEOUT_MS, cwd) => {
    const result = spawnSync(argv[0], argv.slice(1), { encoding: "utf8", timeout, killSignal: "SIGKILL", cwd });
    return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr || (result.error?.message ?? "") };
  };

  // Runs an owner's command. Data goes in on stdin and env, never into the command line, because a PR
  // title or check name is text anyone with a branch can choose. Returns "" or what went wrong.
  const defaultHook = (command, input, env) => {
    const result = spawnSync("/bin/sh", ["-c", command], { input, env, encoding: "utf8", timeout: HOOK_TIMEOUT_MS, killSignal: "SIGKILL" });
    if (result.error) return result.error.message;
    return result.status === 0 ? "" : result.stderr.trim() || `exit ${result.status}`;
  };

  // Whether a command only reads. `gh api` writes when given a method, a field or a body; the other
  // `gh` verbs are listed by name, so a new one is refused until someone decides it reads.
  const GH_READS = new Set(["pr list", "pr view", "pr checks", "pr diff", "run list"]);
  const GH_API_WRITES = /^(-X|--method|-f|-F|--field|--raw-field|--input)/;
  const readsOnly = (argv) => argv[0] !== "gh" || isQueueRead(argv) || GH_READS.has(argv.slice(1, 3).join(" ")) || (argv[1] === "api" && !argv.some((arg) => GH_API_WRITES.test(arg)));




  // The real status only: a check run anyone's workflow can name the same, and it isn't a review's mark.
  const clearanceBase = createHash("sha256").update(BASE_BRANCH).digest("hex").slice(0, 32);
  const clearanceContext = (number) => runtime ? `${CLEARED_CONTEXT}/pr-${number}/${clearanceBase}` : CLEARED_CONTEXT;
  const isClearanceContext = ({ __typename: type, context }) => {
    if (type !== "StatusContext" || typeof context !== "string") return false;
    const name = context.toLowerCase();
    const prefix = CLEARED_CONTEXT.toLowerCase();
    return name === prefix || (runtime && name.startsWith(`${prefix}/`) && /^pr-[1-9]\d*\/[0-9a-f]{32}$/u.test(name.slice(prefix.length + 1)));
  };
  const isClearedStatus = (row, number) => isClearanceContext(row) &&
    (runtime ? row.context === clearanceContext(number) : true);

  // Queue candidates need a full head, an actual clearance status, and nonempty green CI.
  const classify = (pr) => {
    const rows = checkRows(pr.statusCheckRollup);
    const clearedRow = rows?.find((row) => isClearedStatus(row, pr.number));
    const clearedAt = clearedRow?.state === "SUCCESS" && Number.isFinite(Date.parse(clearedRow.startedAt)) ? clearedRow.startedAt : null;
    const checks = rows?.filter((row) => !isClearanceContext(row) && !(row.__typename === "StatusContext" && isGateContext(row.context)));
    const verdict = rows ? ciVerdict(checks) : "unknown";
    const base = { number: pr.number, title: pr.title ?? "", head: pr.headRefOid ?? "", clearedAt, fork: pr.isCrossRepository !== false, checksDone: checks?.length > 0 && checks.every((row) => ["green", "red"].includes(ciVerdict([row]))) };
    if ((!pr.isDraft || clearedAt) && verdict === "red") return { ...base, kind: "failure", failure: "failing", detail: checks.filter((row) => ciVerdict([row]) === "red").map((row) => row.name).join(", ") };
    if ((!pr.isDraft || clearedAt) && pr.mergeable === "CONFLICTING") return { ...base, kind: "failure", failure: "conflict", detail: `conflicts with ${BASE_BRANCH}` };
    if (pr.isDraft !== false) return { ...base, kind: "draft", detail: clearedAt ? "cleared, but still a draft: its heavy checks haven't run" : "draft" };
    if (verdict === "unknown" || !isSha(base.head) || pr.mergeable !== "MERGEABLE") return { ...base, kind: "running", detail: "checks or mergeability unavailable" };
    if (!clearedAt) return { ...base, kind: "reviews", detail: "ready; no cleared status on this head" };
    if (verdict !== "green") return { ...base, kind: "running", detail: "cleared; checks still running" };
    return { ...base, kind: "cleared", detail: "cleared and green" };
  };

  // Existing adapters may establish trust in their configured context. Standalone deployments can
  // additionally pin the publisher. Only the latest status for the context can authorize a write.
  const clearanceProblem = (head, number, run) => {
    if (!CLEARANCE_PUBLISHER) return runtime ? "no trusted clearance publisher configured" : "";
    if (runtime) {
      const latest = runtime.latestClearance(run, head, clearanceContext(number));
      if (latest.error) return "can't read clearance publisher";
      return latest.status?.state === "success" && latest.status.creator?.id === CLEARANCE_PUBLISHER ? "" : "no clearance from the trusted publisher on this head";
    }
    const result = run(["gh", "api", `repos/{owner}/{repo}/commits/${head}/statuses?per_page=100`]);
    const statuses = result.status === 0 ? parseJson(result.stdout) : null;
    if (!Array.isArray(statuses) || statuses.some((status) => typeof status?.context !== "string")) return "can't read clearance publisher";
    const latest = statuses.find((status) => status.context.toLowerCase() === clearanceContext(number).toLowerCase());
    return latest?.state === "success" && latest.creator?.id === CLEARANCE_PUBLISHER ? "" : "no clearance from the trusted publisher on this head";
  };

  // Whether the switch reads `on`. A 404 is "not set"; any other failure (a 502, a timeout, no network) is
  // a read that failed, which alarms where an off or unset switch does not. Needs Variables: read.
  const readSwitch = (run, dir, now) => {
    if (runtime) return runtime.readSwitch(dir, now);
    const result = run(["gh", "api", `repos/{owner}/{repo}/actions/variables/${ENABLED_VARIABLE}`]);
    if (result.status === 0) {
      const value = parseJson(result.stdout)?.value;
      if (typeof value !== "string") return { on: false, unreadable: true, why: `can't read ${ENABLED_VARIABLE}: bad output` };
      return value === ENABLED_VALUE ? { on: true, value } : { on: false, value, why: `${ENABLED_VARIABLE} is "${value}", not "${ENABLED_VALUE}"` };
    }
    if (/\bHTTP 404\b/.test(result.stderr)) return { on: false, unset: true, why: `${ENABLED_VARIABLE} is not set` };
    return { on: false, unreadable: true, why: `can't read ${ENABLED_VARIABLE}: ${result.stderr.trim() || "no output"}` };
  };

  const switchLine = (sw) => (sw.on ? `switch: ${ENABLED_VARIABLE} is "${sw.value}": ticks act` : sw.unreadable ? `switch: ? ${sw.why}; a tick does nothing` : `switch: ${sw.why}; a tick does nothing`);

  const devTip = (run) => {
    const result = run(["gh", "api", `repos/{owner}/{repo}/commits/${encodeURIComponent(BASE_BRANCH)}`, "--jq", ".sha"]);
    const sha = result.stdout.trim();
    return result.status === 0 && isSha(sha) ? { sha } : { error: `can't read ${BASE_BRANCH}'s tip: ${result.stderr.trim() || "bad output"}` };
  };

  // Only a successful push run on the current base tip qualifies. A commit message is not CI evidence.
  const devState = (run) => {
    const result = run(["gh", "run", "list", "--branch", BASE_BRANCH, "--event", "push", "--workflow", DEV_WORKFLOW, "--limit", "1", "--json", "status,conclusion,headSha"]);
    const runs = result.status === 0 ? parseJson(result.stdout) : null;
    if (!Array.isArray(runs)) return { green: false, unreadable: true, why: `can't read ${BASE_BRANCH}'s runs: ${result.stderr.trim() || "bad output"}` };
    if (runs.length === 0) return { green: false, why: `${BASE_BRANCH} has no ${DEV_WORKFLOW} run on a push` };
    const [last] = runs;
    if (!isSha(last?.headSha) || typeof last.status !== "string") return { green: false, unreadable: true, why: `can't read ${BASE_BRANCH}'s last run` };
    if (last.status !== "completed") return { green: false, why: `${BASE_BRANCH}'s run at ${short(last.headSha)} is still going (${last.status})` };
    if (last.conclusion !== "success") return { green: false, red: last.headSha, why: `${BASE_BRANCH}'s run at ${short(last.headSha)} ended ${last.conclusion}` };
    const tip = devTip(run);
    if (tip.error) return { green: false, unreadable: true, why: tip.error };
    if (tip.sha === last.headSha) return { green: true, sha: tip.sha };
    return { green: false, why: `${BASE_BRANCH}'s tip ${short(tip.sha)} has no finished ${DEV_WORKFLOW} run yet` };
  };

  // Compare immutable commits. Strict checks also enforce this at GitHub's merge boundary.
  const staleness = (head, run, baseSha) => {
    const tip = baseSha ? { sha: baseSha } : devTip(run);
    if (tip.error) return tip;
    const result = run(["gh", "api", `repos/{owner}/{repo}/compare/${head}...${tip.sha}`, "--jq", ".ahead_by"]);
    const ahead = result.status === 0 ? parseJson(result.stdout) : null;
    if (!Number.isSafeInteger(ahead) || ahead < 0) return { error: `can't compare ${short(head)} with ${BASE_BRANCH}` };
    return ahead > 0 ? { stale: true, why: `${BASE_BRANCH} advanced by ${ahead} commit(s)` } : { stale: false };
  };

  // An open release PR freezes the base so its head and checks do not change.
  const shipState = (run) => {
    if (runtime && !runtime.shipFreeze) return { blocked: false };
    const result = run(["gh", "pr", "list", "--base", SHIP_BRANCH, "--head", BASE_BRANCH, "--state", "open", "--json", "number"]);
    const open = result.status === 0 ? parseJson(result.stdout) : null;
    if (!Array.isArray(open)) return { blocked: true, error: true, why: `can't tell whether a ship PR is open: ${result.stderr.trim() || "bad output"}` };
    return open.length > 0 ? { blocked: true, why: `ship PR #${open[0].number} is open, so ${BASE_BRANCH} is frozen` } : { blocked: false };
  };

  // Why this clone can't be trusted to merge, or "". The hold list and the merge path run from its
  // files with the token, so it must be exactly the base tip: not another branch, behind, or edited.
  const cloneProblem = (cwd, run) => {
    const branch = run(["git", "-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"]);
    if (branch.status !== 0) return "can't read the worker's branch";
    if (branch.stdout.trim() !== BASE_BRANCH) return `this clone is on ${branch.stdout.trim() || "no branch"}, not ${BASE_BRANCH}`;
    const git = ["git", "-c", "core.fsmonitor=false", "--no-optional-locks", "-C", cwd];
    if (runtime) {
      const settings = run([...git, "config", "--null", "--name-only", "--list"]);
      if (settings.status !== 0) return "can't read checkout filter settings";
      const drivers = new Set(settings.stdout.split("\0").flatMap((name) => {
        const match = /^(filter\..+)\.(?:clean|process)$/u.exec(name);
        return match ? [match[1]] : [];
      }));
      // A submodule can have its own filter configuration. Use a worker checkout without submodules.
      const index = run([...git, "ls-files", "--stage", "-z"]);
      if (index.status !== 0) return "can't read the worker's index";
      if (/(?:^|\0)160000 /u.test(index.stdout)) return "the worker checkout contains submodules";
      for (const driver of drivers) {
        git.push("-c", `${driver}.clean=`, "-c", `${driver}.process=`, "-c", `${driver}.required=false`);
      }
    }
    const status = run([...git, "status", "--porcelain"]);
    if (status.status !== 0) return "can't read the worker's checkout status";
    if (status.stdout.trim()) return "this clone has uncommitted changes";
    const tip = devTip(run);
    if (tip.error) return tip.error;
    const local = run(["git", "-C", cwd, "rev-parse", "HEAD"]);
    if (local.status !== 0 || !isSha(local.stdout.trim())) return "can't read the worker's HEAD";
    return local.stdout.trim() === tip.sha ? "" : `this clone is at ${short(local.stdout.trim())}, which isn't ${BASE_BRANCH}'s tip ${short(tip.sha)}`;
  };

  const heldState = (pr, run, base) => {
    const state = runtime ? readHeld(String(pr.number), run, { base, baseName: BASE_BRANCH }) : readHeld(String(pr.number), run);
    if (state?.error) return { error: state.error };
    if (state?.head !== pr.head || !Array.isArray(state.paths) || state.paths.length === 0 ||
      !state.paths.every((path) => typeof path === "string" && path.length > 0) || !Array.isArray(state.files) || state.files.length === 0) {
      return { error: `can't verify held paths for #${pr.number} at ${short(pr.head)}` };
    }
    return state;
  };

  const openHolds = (dir, number, now, state) => heldBy(state.paths).filter((why) => !approved(dir, now, { pr: String(number), scope: `hold:${why}`, head: state.head, digest: heldDigest(state.files, why) }));



  // The weekly line: PRs merged, and approved to on dev. The clock starts at the plan's `approved` note,
  // else the cleared status, and stops at mergedAt. A PR with neither is counted, not guessed.
  const reportLine = (cwd, run, now, days = REPORT_DAYS) => {
    const since = new Date(now.getTime() - days * 24 * HOUR);
    const result = run(["gh", "pr", "list", "--state", "merged", "--base", BASE_BRANCH, "--limit", LIST_LIMIT, "--search", `merged:>=${since.toISOString().slice(0, 10)}`, "--json", "number,mergedAt,statusCheckRollup"]);
    const merged = result.status === 0 ? parseJson(result.stdout) : null;
    if (!Array.isArray(merged)) return { error: `can't read merged PRs: ${result.stderr.trim() || "bad output"}` };
    const notes = approvalClock(cwd, now);
    const inWindow = merged.filter((pr) => Date.parse(pr.mergedAt) >= since.getTime());
    const spans = inWindow.map((pr) => {
      const start = notes.get(pr.number) ?? checkRows(pr.statusCheckRollup)?.find((row) => isClearedStatus(row, pr.number))?.startedAt;
      return (Date.parse(pr.mergedAt) - Date.parse(start)) / MINUTE;
    });
    // NaN is no clock; below zero is a note written after the merge, which measures nothing.
    const clocked = spans.filter((span) => span >= 0);
    const window = `${since.toISOString().slice(0, 10)} to ${now.toISOString().slice(0, 10)}`;
    const times = clocked.length > 0 ? `approved to on ${BASE_BRANCH} p50 ${minutes(percentile(clocked, 50))}, p90 ${minutes(percentile(clocked, 90))}` : "no approval times";
    const line = `${basename(cwd)} ${window}: ${inWindow.length} merged, ${times} (target p50 ${minutes(TARGET_P50_MINUTES)}, p90 ${minutes(TARGET_P90_MINUTES)}), ${inWindow.length - clocked.length} with no clock`;
    if (!runtime) return { line };
    return { days, since: since.toISOString(), through: now.toISOString(), merged: inWindow.length, unclocked: inWindow.length - clocked.length,
      p50Minutes: clocked.length ? percentile(clocked, 50) : null, p90Minutes: clocked.length ? percentile(clocked, 90) : null,
      complete: merged.length < Number(LIST_LIMIT), line };
  };

  const openPrs = (run) => {
    if (runtime) return runtime.listOpen(run);
    const result = run(["gh", "pr", "list", "--state", "open", "--base", BASE_BRANCH, "--limit", LIST_LIMIT, "--json", "number,title,isDraft,isCrossRepository,headRefOid,mergeable,statusCheckRollup"]);
    const prs = result.status === 0 ? parseJson(result.stdout) : null;
    return Array.isArray(prs) && prs.length < Number(LIST_LIMIT) &&
      prs.every((pr) => Number.isSafeInteger(pr?.number) && pr.number > 0 && isSha(pr.headRefOid)) &&
      new Set(prs.map((pr) => pr.number)).size === prs.length ? { prs } : { error: `can't list open PRs: ${result.stderr.trim() || "bad output"}` };
  };

  // Keep the existing merge adapters' review policy. Route their supported merge commands through
  // the same direct writer, with the configured method and no auto-merge, queue or bypass option.
  const commandoMerge = (pr, { cwd, run, now, out, err, wrangle, submit }) =>
    commando(["merge", String(pr.number)], {
      cwd, run, now, out, err,
      merge: (args, options) => {
        if (options.wantHead !== pr.head) {
          err(`conveyor: #${pr.number}'s reviewed head changed; refusing`);
          return 1;
        }
        const guardedRun = (argv, timeout) => {
          if (argv[0] === "gh" && argv[1] === "pr" && argv[2] === "merge") {
            const headAt = argv.indexOf("--match-head-commit");
            if (argv[3] === String(pr.number) && headAt >= 0 && argv[headAt + 1] === pr.head) return submit();
          } else if (argv[0] === "gh" && argv[1] === "api" && argv.includes("--method") && argv.includes("PUT")) {
            if (argv.includes(`repos/{owner}/{repo}/pulls/${pr.number}/merge`) && argv.includes(`sha=${pr.head}`)) return submit();
          } else if (readsOnly(argv)) return run(argv, timeout);
          return { status: 1, stdout: "", stderr: "merge adapter attempted an unsupported write" };
        };
        return wrangle(["--wait-minutes", String(MERGE_WAIT_MINUTES), ...args], {
          ...options, run: guardedRun, base: BASE_BRANCH, releaseBranch: SHIP_BRANCH, mergeMethod: MERGE_METHOD,
        });
      },
    });

  // Check base CI during an active tick, even when no PR is waiting.
  const watchDev = ({ run, now, state, alarm }) => {
    const dev = devState(run);
    if (dev.green) {
      delete state.devBlockedSince;
      return dev;
    }
    state.devBlockedSince ??= now.toISOString();
    const stuck = now.getTime() - Date.parse(state.devBlockedSince) >= DEV_STUCK_MINUTES * MINUTE;
    if (dev.red) alarm(`dev-red:${dev.red}`, `${dev.why}. Nothing merges until it is green.`);
    else if (dev.unreadable || stuck) alarm(`dev-stuck:${hourOf(now)}`, `${dev.why}. Nothing merges until ${BASE_BRANCH} is green.`);
    return dev;
  };

  // Read the specific PR, even if a list omits it. An unavailable outcome blocks all other writes.
  // Legacy updates can settle here but their clearance is never carried to the new head.
  const reconcile = ({ state, now, run, alarm, seen }) => {
    const operation = state.operation ?? (state.updating && { ...state.updating, kind: "update", base: BASE_BRANCH });
    if (!operation) return false;
    const key = `${operation.kind}:${operation.number}@${operation.head}`;
    const waiting = (reason, unreadable = false) => {
      seen.why.push(reason);
      if (unreadable) seen.unread.push(reason);
      alarm(`reconcile:${key}:${hourOf(now)}`, reason);
      return true;
    };
    if (runtime && operation.repo && operation.repo !== runtime.repo) return waiting("the pending write belongs to a different repository", true);
    const result = readMerge(run, operation.number);
    if (!result) return waiting(`can't reconcile ${operation.kind} of #${operation.number} at ${short(operation.head)}`, true);
    if (result.state === "MERGED" && result.baseRefName === BASE_BRANCH) {
      if (!state.lastMergeAt || Date.parse(result.mergedAt) > Date.parse(state.lastMergeAt)) state.lastMergeAt = result.mergedAt;
    }
    if (runtime && result.state === "MERGED" && operation.kind === "merge" && result.headRefOid === operation.head && result.baseRefName === operation.base) {
      const action = { kind: "merged", number: operation.number, headSha: operation.head, mergeSha: result.mergeCommit.oid, at: result.mergedAt };
      state.lastAction = action;
      if (seen.submitted === operation) seen.outcome = action;
    }
    if (result.state === "MERGED" && (result.headRefOid !== operation.head || result.baseRefName !== operation.base)) {
      alarm(`outcome:${key}`, `#${operation.number} merged with a different head or target than the recorded ${operation.kind}`);
    }
    const age = now.getTime() - Date.parse(operation.at);
    const limit = (operation.kind === "merge" ? MERGE_RETRY_MINUTES : UPDATE_FLIGHT_MINUTES) * MINUTE;
    const unchanged = result.state === "OPEN" && result.headRefOid === operation.head && result.baseRefName === operation.base;
    if (unchanged && age < limit) return waiting(`#${operation.number}'s ${operation.kind} at ${short(operation.head)} is still in flight`);
    if (unchanged) seen.reconciledOpen = operation.number;
    if (operation.kind === "update" && result.state === "OPEN" && !unchanged) {
      const pr = readPull(run, operation.number, ["statusCheckRollup", "isDraft", "mergeable"]);
      if (!pr || pr.headRefOid !== result.headRefOid || pr.baseRefName !== result.baseRefName) return waiting(`can't read #${operation.number}'s updated head`, true);
      if (runtime && operation.baseSha && pr.baseRefName === operation.base && pr.headRefOid !== operation.head) {
        const compared = staleness(pr.headRefOid, run, operation.baseSha);
        if (compared.error) return waiting(`can't verify #${operation.number}'s updated head against the recorded base`, true);
        if (!compared.stale) {
          const prior = staleness(pr.headRefOid, run, operation.head);
          if (prior.error) return waiting(`can't verify #${operation.number}'s updated head against the recorded head`, true);
          if (!prior.stale) {
            const action = { kind: "updated", number: operation.number, headSha: operation.head, newHeadSha: pr.headRefOid, at: now.toISOString() };
            if (state.lastAction?.newHeadSha !== action.newHeadSha || state.lastAction?.number !== action.number) state.lastAction = action;
            if (seen.submitted === operation) seen.outcome = action;
          }
        }
      }
      if (pr.baseRefName === operation.base && !classify(pr).checksDone && age < limit) return waiting(`#${operation.number}'s updated head is still waiting on checks`);
    }
    delete state.operation;
    delete state.updating;
    return false;
  };

  const preflight = (pr, kind, baseSha, { cwd, dir, run, clock, preview = false }) => {
    const ship = shipState(run);
    if (ship.blocked) return ship.why;
    const dev = devState(run);
    if (!dev.green || dev.sha !== baseSha) return dev.why ?? `${BASE_BRANCH} moved during the tick`;
    const clone = cloneProblem(cwd, run);
    if (clone) return clone;
    if (!hasStrictChecks(run, BASE_BRANCH)) return `can't verify strict required checks on ${BASE_BRANCH}`;
    const held = heldState(pr, run, baseSha);
    if (held.error) return held.error;
    const clearance = clearanceProblem(pr.head, pr.number, run);
    if (clearance) return clearance;
    if (!preview && runtime?.policy && !runtime.policy({ kind, number: pr.number, headSha: pr.head }, held.paths)) return "the repository policy refused this action";
    const switchNow = readSwitch(run, dir, clock());
    if (!switchNow.on) return switchNow.why;
    // Read the exact target last because the write API only pins the head.
    const live = readPull(run, pr.number, ["baseRefOid", "isDraft", "mergeable", "mergeStateStatus", "isCrossRepository", "statusCheckRollup"]);
    if (!live || live.state !== "OPEN" || live.baseRefName !== BASE_BRANCH || live.headRefOid !== pr.head || live.baseRefOid !== baseSha) return `#${pr.number}'s head or base changed or could not be verified`;
    if (classify(live).kind !== "cleared") return `#${pr.number}'s clearance, CI or mergeability changed`;
    if (kind === "merge" && live.mergeStateStatus !== "CLEAN") return `GitHub does not report #${pr.number} ready to merge`;
    if (kind === "update" && live.isCrossRepository !== false) return `#${pr.number} cannot be updated from this repository`;
    // Consent and hold approvals can expire during any of the remote reads.
    const at = clock();
    const until = activeUntil(dir, at);
    if (!(until instanceof Date) || !(until > at)) return "commando is off";
    const classes = openHolds(dir, pr.number, at, held);
    return classes.length > 0 ? `held without approval (${classes.join(", ")})` : "";
  };

  // Collect only the observations needed to select a write. Queue inspection can
  // continue past that point to describe the other PRs with the same policy.
  function* candidateObservations(prs, state, now, reconciledOpen, { dev, dir, run }) {
    for (const candidate of rankedCandidates(prs, state, now, MERGE_RETRY_MINUTES * MINUTE, reconciledOpen)) {
      const { pr, mergeRetryAt } = candidate;
      const held = mergeRetryAt ? undefined : heldState(pr, run, dev.sha);
      const classes = held && !held.error ? openHolds(dir, pr.number, now, held) : undefined;
      const moved = held && !held.error && !classes.length ? staleness(pr.head, run, dev.sha) : undefined;
      let decision = candidateDecision(candidate, { held, classes, moved }, AUTO_UPDATE);
      if (runtime && ["merge", "update"].includes(decision.kind)) {
        const clearance = clearanceProblem(pr.head, pr.number, run);
        if (clearance) {
          const issue = preflightIssue(clearance);
          decision = { kind: issue.unknown ? "unknown" : "blocked", ...issue.reason };
        } else if (decision.kind === "merge") {
          const live = readPull(run, pr.number, ["baseRefOid", "mergeStateStatus"]);
          if (!live || live.headRefOid !== pr.head || live.state !== "OPEN" || live.baseRefName !== BASE_BRANCH || live.baseRefOid !== dev.sha ||
            !live.mergeStateStatus || live.mergeStateStatus === "UNKNOWN") {
            decision = { kind: "unknown", code: "pr_evidence_unavailable", message: "Could not verify the pull request's merge state." };
          } else if (live.mergeStateStatus !== "CLEAN") {
            decision = { kind: "blocked", code: "github_not_ready", message: "GitHub does not report the head ready for this action." };
          }
        }
      }
      yield { pr, held, moved, decision };
    }
  }

  const mergeOne = async ({ prs, dev, state, alarm, cwd, dir, now, run, clock, land, save, seen, dry }) => {
    if (!rankedCandidates(prs, state, now, MERGE_RETRY_MINUTES * MINUTE, seen.reconciledOpen).some((candidate) => !candidate.mergeRetryAt)) {
      seen.why.push("no PR is cleared, green and past its retry wait");
      return;
    }
    if (state.lastMergeAt && now.getTime() - Date.parse(state.lastMergeAt) < DEV_SETTLE_MINUTES * MINUTE) {
      seen.why.push(`the last merge was under ${DEV_SETTLE_MINUTES} minutes ago`);
      return;
    }
    const ship = shipState(run);
    if (ship.blocked) {
      if (ship.error) seen.unread.push(ship.why);
      seen.why.push(ship.why);
      return;
    }
    if (!dev.green) {
      seen.why.push(dev.why);
      return;
    }
    const observations = [];
    for (const observation of candidateObservations(prs, state, now, seen.reconciledOpen, { dev, dir, run })) {
      const { pr, held, moved, decision } = observation;
      observations.push(observation);
      if (held?.error || moved?.error) {
        const reason = held?.error ?? moved.error;
        alarm(`${held?.error ? "hold-read" : "stale-read"}:${pr.number}:${hourOf(now)}`, reason);
        seen.unread.push(reason);
        break;
      }
      if (decision.holds) {
        alarm(`held:${pr.number}@${pr.head}`, `#${pr.number} waits for separate approval (${decision.holds.join(", ")}). (${pr.title})`);
        seen.why.push(`#${pr.number} is held (${decision.holds.join(", ")}) with no approval in force`);
      }
      if (moved?.stale) {
        seen.why.push(`#${pr.number} is stale: ${moved.why}`);
        if (pr.fork) alarm(`fork:${pr.number}@${pr.head}`, `#${pr.number} is stale and comes from a fork; a session needs to update it. (${pr.title})`);
      }
      if (decision.kind === "unknown") {
        seen.unread.push(decision.message);
        break;
      }
      if (decision.kind === "merge") break;
    }
    const { selected } = chooseAction(observations);
    if (!selected) return;
    const { pr, decision: { kind } } = selected;
    const prepare = () => {
      const reason = preflight(pr, kind, dev.sha, { cwd, dir, run, clock, preview: dry });
      if (reason) {
        seen.why.push(reason);
        if (runtime) {
          seen.blocked = reason;
          seen.preflight = reason;
        }
        return reason;
      }
      if (dry) return "";
      const at = clock();
      state.operation = { kind, number: pr.number, head: pr.head, base: BASE_BRANCH, baseSha: dev.sha, at: at.toISOString(),
        ...(runtime ? { repo: runtime.repo } : {}) };
      const attempt = `${pr.number}@${pr.head}`;
      const key = kind === "update" ? `update:${attempt}` : attempt;
      const previousAttempt = state.attempts[key];
      state.attempts[key] = state.operation.at;
      save(at);
      if (runtime && !readSwitch(run, dir, clock()).on) {
        delete state.operation;
        if (previousAttempt === undefined) delete state.attempts[key];
        else state.attempts[key] = previousAttempt;
        seen.preflight = "commando is off";
        return seen.preflight;
      }
      seen.submitted = state.operation;
      return "";
    };
    if (dry) {
      if (!prepare()) seen[kind] = pr;
      return;
    }
    if (kind === "update") {
      if (prepare()) return;
      updatePull(run, pr.number, pr.head);
      reconcile({ state, now: clock(), run, alarm, seen });
      return;
    }
    if (!runtime) state.attempts[`${pr.number}@${pr.head}`] = clock().toISOString();
    const submit = () => {
      if (state.operation) return { status: 1, stdout: "", stderr: "a write was already attempted this tick" };
      const reason = prepare();
      return reason ? { status: 1, stdout: "", stderr: reason } : mergePull(run, pr.number, pr.head, MERGE_METHOD);
    };
    const code = await (runtime ? submit().status : land(pr, submit));
    if (state.operation) reconcile({ state, now: clock(), run, alarm, seen });
    else if (code !== 0 && !seen.preflight) alarm(`merge:${pr.number}@${pr.head}`, `#${pr.number}'s merge was refused (exit ${code}); retrying in ${MERGE_RETRY_MINUTES} minutes. (${pr.title})`);
  };

  // One pass. Alarms and marks go through `tell`, `alarm` and `state`, which `tick` owns.
  const pass = async ({ cwd, run, clock, env, hook, dir, now, state, tell, alarm, save, land, seen, dry }) => {
    state.lastTickAt = now.toISOString();

    const stale = cloneProblem(cwd, run);
    if (stale) alarm(`stale:${hourOf(now)}`, `${stale}. Nothing merges from here until it is on ${BASE_BRANCH}'s tip.`);
    if (stale.startsWith("can't read")) seen.unread.push(stale);

    const consent = activeUntil(dir, now);
    const until = consent instanceof Date && consent > now ? consent : null;
    Object.assign(seen, { stale, until });
    if (until && until.getTime() - now.getTime() <= COMMANDO_WARN_HOURS * HOUR) alarm(`commando-ending:${until.toISOString()}`, `commando ends at ${until.toISOString()}. \`pnpm commando on <hours>\` in this clone keeps the merges going.`);

    const dev = watchDev({ run, now, state, alarm });
    seen.dev = dev;
    if (dev.unreadable) seen.unread.push(dev.why);

    const pending = reconcile({ state, now, run, alarm, seen });
    const listed = openPrs(run);
    if (listed.error) {
      alarm(`gh:${hourOf(now)}`, listed.error);
      seen.unread.push(listed.error);
      seen.why.push("the open PRs couldn't be read");
      return REPORTED;
    }
    const prs = listed.prs.map(classify);
    seen.prs = prs;
    if (runtime && (!listed.complete || listed.prs.some((pr) => !knownInputs(pr)))) {
      seen.blocked = "the queue is incomplete";
      seen.unread.push(seen.blocked);
      return REPORTED;
    }
    for (const key of Object.keys(state.voided)) if (!prs.some((pr) => `${pr.number}@${pr.head}` === key)) delete state.voided[key];

    // A failure is told once per head. The hook has its own mark, written before it starts, so a crash or
    // an alarm being re-sent can't start a second session.
    for (const pr of prs.filter((p) => p.kind === "failure")) {
      const key = `failure:${pr.number}@${pr.head}:${pr.failure}`;
      const command = env.CONVEYOR_ON_FAILURE_COMMAND;
      alarm(key, `#${pr.number} at ${short(pr.head)}: ${pr.detail}. It needs a session${command ? "; running CONVEYOR_ON_FAILURE_COMMAND" : ""}. (${pr.title})`);
      if (!command || state.hooked[key]) continue;
      state.hooked[key] = now.toISOString();
      save(now);
      const problem = hook(command, `${pr.title}\n`, { ...env, CONVEYOR_PR: String(pr.number), CONVEYOR_HEAD: pr.head, CONVEYOR_KIND: pr.failure, CONVEYOR_DETAIL: pr.detail });
      if (problem) alarm(`hook:${key}`, `CONVEYOR_ON_FAILURE_COMMAND failed for #${pr.number}: ${problem}`);
    }

    // Age: approved work in a plan (with or without a PR), then cleared PRs no plan note covers. Skipped
    // when PR states can't be read: a merged PR would read as not on dev, and its alarm's key is spent.
    const work = approvedWork(cwd, now);
    const known = knownPrs(work, run);
    if (!known) seen.unread.push("can't read PR states, so approved work's age is not checked");
    if (known) {
      const approvedPhases = work(known);
      for (const phase of approvedPhases.filter((w) => w.due !== "none")) {
        alarm(`age:${phase.plan}/${phase.phase}:${phase.due}`, `${phase.plan} phase ${phase.phase} was approved ${phase.ageHours}h ago and isn't on ${BASE_BRANCH} (${phase.prs.length > 0 ? phase.prs.map((n) => `#${n}`).join(", ") : "no PR"}, ${phase.status || "not started"}).`);
      }
      const inPlans = new Set(approvedPhases.flatMap((w) => w.prs));
      for (const pr of prs.filter((p) => p.clearedAt && !inPlans.has(p.number))) {
        const hours = (now.getTime() - Date.parse(pr.clearedAt)) / HOUR;
        const due = hours >= APPROVED_TELL_HOURS ? "tell" : hours >= APPROVED_POKE_HOURS ? "poke" : "";
        if (due) alarm(`age:#${pr.number}@${pr.head}:${due}`, `#${pr.number} was cleared ${hours.toFixed(1)}h ago and isn't on ${BASE_BRANCH}: ${until ? pr.detail : "commando is off in this clone"}. (${pr.title})`);
      }
    }

    if (!state.lastReportAt || now.getTime() - Date.parse(state.lastReportAt) >= REPORT_DAYS * 24 * HOUR) {
      const report = reportLine(cwd, run, now);
      if (report.error) {
        alarm(`report-read:${now.toISOString().slice(0, 10)}`, report.error);
        seen.unread.push(report.error);
      } else {
        tell(`report:${now.toISOString().slice(0, 10)}`, `conveyor report: ${report.line}`);
        state.lastReportAt = now.toISOString();
      }
    }
    // Saved before the merge: a merge can wait minutes, and a crash there mustn't repeat these alarms.
    save(now);

    seen.blocked = !until ? "commando is off in this clone" : runtime && !CLEARANCE_PUBLISHER ? "no trusted clearance publisher configured"
      : stale || (pending ? "a GitHub write is being reconciled" : "");
    if (!seen.blocked) await mergeOne({ prs, dev, state, alarm, cwd, dir, now, run, clock, land, save, seen, dry });
    return 0;
  };

  // What a dry run prints, from what `pass` saw: the world as the tick read it, then what it would send and do.
  // A read that failed prints `?`, never green. Returns the exit code: 1 if any read failed.
  const dryReport = (seen, { out, alarms, hooks, queued }) => {
    const { until, stale, dev, prs, blocked } = seen;
    out("conveyor tick --dry-run: reads only. Nothing was merged, posted, sent, run or saved.");
    out(switchLine(seen.switch));
    if (!seen.switch.on) {
      out(`a real tick would do nothing: ${seen.switch.why}${seen.switch.unreadable ? ", and would alarm" : ""}. Nothing else was read.`);
      return seen.switch.unreadable ? 1 : 0;
    }
    out(until ? `commando: on until ${until.toISOString()}, in this clone` : "commando: off in this clone, so a real tick would merge nothing");
    out(`clone: ${stale?.startsWith("can't read") ? "?" : stale || `on ${BASE_BRANCH}'s tip`}`);
    out(`${BASE_BRANCH}: ${!dev ? "not read" : dev.green ? "green" : dev.unreadable ? "?" : `not green: ${dev.why}`}`);
    out(`open PRs: ${prs ? prs.length : "?"}`);
    for (const pr of prs ?? []) out(`  #${pr.number} ${pr.kind} at ${short(pr.head)}: ${pr.detail}`);
    if (queued > 0) out(`${queued} queued alarm${queued === 1 ? "" : "s"} would be sent first`);
    out(alarms.length > 0 ? `would send ${alarms.length} alarm${alarms.length === 1 ? "" : "s"}:` : "would send no alarms");
    for (const line of alarms) out(`  ${line}`);
    for (const line of hooks) out(`would run CONVEYOR_ON_FAILURE_COMMAND: ${line}`);
    for (const text of seen.unread) out(`? ${text}`);
    if (seen.update) out(`would update #${seen.update.number} at ${short(seen.update.head)} from ${BASE_BRANCH}, with a merge commit`);
    const merge = seen.merge ? `#${seen.merge.number} at ${short(seen.merge.head)} (${seen.merge.title})` : "";
    if (blocked) out(`a real tick would merge nothing: ${blocked}`);
    if (merge) out(blocked ? `with that cleared, it would merge ${merge}` : `would merge ${merge}`);
    else out(`${blocked ? "with that cleared, it" : "it"} would merge nothing: ${seen.why.join("; ") || "nothing was decided"}`);
    return seen.unread.length > 0 ? 1 : 0;
  };

  // A dry run's `run`: a write throws, and the pass reports it.
  const readOnlyRun = (run) => (argv, timeout) => {
    if (!readsOnly(argv)) throw new Error(`dry run refused a write: ${argv.join(" ")}`);
    return run(argv, timeout);
  };

  // A tick with its alarm channel and its state: whatever happens in the pass, it is reported and the marks are saved.
  // `dry` runs the same pass with every write left out: nothing is saved, logged, sent, run or merged,
  // and `gh` may only read. It prints what each of those would have done.
  const tick = async ({ cwd, dir, clock, out, err, env, hook, dry = false, wrangle, run: realRun, observe }) => {
    const now = clock();
    const run = dry ? readOnlyRun(realRun) : realRun;
    // First, before any other read: the switch decides whether anything else happens.
    const enabled = readSwitch(run, dir, now);
    const path = join(dir, STATE_NAME);
    const { state, corrupt } = readState(path);
    if (corrupt) {
      observe?.({ corrupt: true });
      err(`conveyor: ${STATE_NAME} is unreadable or unsupported; resolve it before retrying`);
      return REPORTED;
    }
    const seen = { switch: enabled, why: [], unread: [], merge: null, blocked: "" };
    const alarms = [];
    const hooks = [];
    const logLine = (line) => appendFileSync(join(dir, LOG_NAME), `${clock().toISOString()} ${line}\n`);
    const save = (at) => {
      if (!dry) writeState(path, state, at.getTime() - STATE_KEEP_DAYS * 24 * HOUR);
    };
    // One try per tick at a command that is down: each can take a minute, and the queue may be long.
    let down = false;
    const deliver = (line) => {
      if (down) return false;
      let problem;
      if (runtime?.notify) {
        try {
          const receipt = runtime.notify(line);
          if (typeof receipt?.then === "function") {
            Promise.resolve(receipt).catch(() => {});
            problem = "notification callback must finish synchronously";
          }
        } catch {
          problem = "notification callback failed";
        }
      } else problem = env.CONVEYOR_ALARM_COMMAND ? hook(env.CONVEYOR_ALARM_COMMAND, `${line}\n`, env) : runtime ? "notification callback is not configured" : "";
      if (!problem) return true;
      down = true;
      err(runtime ? `conveyor: notification failed: ${problem}` : `conveyor: CONVEYOR_ALARM_COMMAND failed: ${problem}`);
      return false;
    };
    // What a down command missed goes first, oldest first. It is retried from here because the condition
    // behind it may never come back: the PR closes, the hour passes, the failure hook has already run.
    const flush = () => {
      while (state.outbox.length > 0 && deliver(state.outbox[0].line)) state.alarmed[state.outbox.shift().key] = now.toISOString();
      if (state.outbox.length === 0 && state.outboxDropped > 0 && deliver(`conveyor alarm: ${state.outboxDropped} older alarms were dropped while CONVEYOR_ALARM_COMMAND was down; they are in ${LOG_NAME}.`)) state.outboxDropped = 0;
    };
    // Stdout and the log get a line at once. The owner's command gets it now, or from the queue later.
    const tell = (key, line) => {
      if (state.alarmed[key] || state.outbox.some((queued) => queued.key === key)) return;
      if (dry) {
        // Marked in memory only, so the same alarm isn't listed twice.
        state.alarmed[key] = now.toISOString();
        alarms.push(line);
        return;
      }
      out(line);
      logLine(line);
      if (deliver(line)) {
        state.alarmed[key] = now.toISOString();
        return;
      }
      state.outbox.push({ key, line });
      if (state.outbox.length > OUTBOX_MAX) {
        state.outbox.shift();
        state.outboxDropped += 1;
      }
    };
    const alarm = (key, line) => tell(key, `conveyor alarm: ${line}`);
    const land = (pr, submit) => commandoMerge(pr, { cwd, run, now: clock(), out, err, wrangle, submit });
    const failureHook = dry ? (_command, _input, hookEnv) => (hooks.push(`#${hookEnv.CONVEYOR_PR} at ${short(hookEnv.CONVEYOR_HEAD)}`), "") : hook;
    const report = () => dryReport(seen, { out, alarms, hooks, queued: state.outbox.length });
    const recordSuccess = (code) => {
      const unconfirmed = (state.operation || state.updating || seen.submitted) && !seen.outcome;
      if (runtime && code === 0 && seen.unread.length === 0 && !seen.preflight && !unconfirmed) {
        state.lastSuccessfulTickAt = now.toISOString();
      }
      return code;
    };
    // The switch isn't on: no merge, no hook. An off or unset switch is a choice, so it is told to stdout and
    // logged when it changes. One that couldn't be read goes the alarm path, so a dead conveyor is noticed.
    const stop = () => {
      state.lastTickAt = now.toISOString();
      if (enabled.unreadable) {
        flush();
        alarm(`switch:${hourOf(now)}`, `${enabled.why}. Nothing merges until it can be read.`);
        return REPORTED;
      }
      out(`conveyor: ${enabled.why}; doing nothing`);
      if (state.stopped !== enabled.why) logLine(`conveyor: ${enabled.why}; doing nothing`);
      state.stopped = enabled.why;
      return 0;
    };
    try {
      if (dry) {
        if (!enabled.on) return report();
      } else if (!enabled.on) {
        reconcile({ state, now, run, alarm, seen });
        return recordSuccess(stop());
      } else if (state.stopped) {
        logLine(`conveyor: ${ENABLED_VARIABLE} is "${ENABLED_VALUE}" again; acting`);
        delete state.stopped;
      }
      if (!dry) flush();
      const code = await pass({ cwd, run, clock, env, hook: failureHook, dir, now, state, tell, alarm, save, land, seen, dry });
      return dry ? report() : recordSuccess(code);
    } catch (error) {
      if (dry) {
        seen.unread.push(`the pass failed: ${error.message}`);
        return report();
      }
      alarm(`crash:${hourOf(now)}`, `tick failed: ${error.message}`);
      return REPORTED;
    } finally {
      observe?.(seen);
      save(clock());
    }
  };

  const status = ({ cwd, run, now, out, err, dir }) => {
    out(switchLine(readSwitch(run)));
    const until = activeUntil(dir, now);
    const { state, corrupt } = readState(join(dir, STATE_NAME));
    if (corrupt) {
      err(`conveyor: ${STATE_NAME} is unreadable or unsupported`);
      return 1;
    }
    out(until ? `commando on until ${until.toISOString()}, in this clone` : "commando off in this clone (the switch is per clone; the timer reads its own)");
    out(state.lastTickAt ? `last tick ${state.lastTickAt}` : "no tick yet in this clone: is the timer installed, and is this its clone?");
    out(`clone: ${cloneProblem(cwd, run) || `on ${BASE_BRANCH}'s tip`}`);
    if (state.operation) out(`${state.operation.kind} in flight: #${state.operation.number} at ${short(state.operation.head)}, since ${state.operation.at}`);
    if (state.updating) out(`update in flight: #${state.updating.number} from ${short(state.updating.head)}, since ${state.updating.at}`);
    for (const [key, { classes }] of Object.entries(state.voided)) {
      const [number, head] = key.split("@");
      out(`#${number} at ${short(head)}: its update from ${BASE_BRANCH} voided the yes for ${classes.join(", ")}; it needs \`pnpm approve ${number}\``);
    }
    const listed = openPrs(run);
    if (listed.error) {
      err(`conveyor: ${listed.error}`);
      return 1;
    }
    for (const pr of listed.prs.map(classify)) out(`#${pr.number} ${pr.kind} at ${short(pr.head)}: ${pr.detail}`);
    const ship = shipState(run);
    if (ship.blocked) out(ship.why);
    const dev = devState(run);
    out(dev.green ? `${BASE_BRANCH} green` : `${BASE_BRANCH} not green: ${dev.why}`);
    const logFile = join(dir, LOG_NAME);
    if (existsSync(logFile)) out(`recent:\n${readFileSync(logFile, "utf8").trimEnd().split("\n").slice(-10).join("\n")}`);
    return 0;
  };

  // Posts the status on one head. Returns "" or what went wrong.
  const postCleared = (run, number, head, description) => {
    const post = run(["gh", "api", "--method", "POST", `repos/{owner}/{repo}/statuses/${head}`, "-f", "state=success", "-f", `context=${clearanceContext(number)}`, "-f", `description=${description}`]);
    return post.status === 0 ? "" : post.stderr.trim() || `exit ${post.status}`;
  };

  // Records a passed review on the head that was reviewed. The head is named, not read, so a push made
  // during the reviews is refused rather than cleared unseen.
  const clear = (number, head, { run, out, err }) => {
    const view = run(["gh", "pr", "view", number, "--json", "baseRefName,headRefOid,state"]);
    const pr = view.status === 0 ? parseJson(view.stdout) : null;
    if (!pr) {
      err(`conveyor: can't read #${number}: ${view.stderr.trim()}`);
      return 1;
    }
    if (pr.state !== "OPEN" || pr.baseRefName !== BASE_BRANCH) {
      err(`conveyor: #${number} is ${pr.state} into ${pr.baseRefName}; only an open PR into ${BASE_BRANCH} can be cleared.`);
      return 1;
    }
    if (pr.headRefOid !== head) {
      err(`conveyor: #${number}'s head is ${short(pr.headRefOid)}, not ${head}; review the new head, then clear it.`);
      return 1;
    }
    const problem = postCleared(run, number, pr.headRefOid, "Reviews passed at this head");
    if (problem) {
      err(`conveyor: can't post the status on #${number}: ${problem}`);
      return 1;
    }
    out(`#${number} cleared at ${short(pr.headRefOid)}; a later push voids it`);
    return 0;
  };

  const reason = (code, message, extra) => ({ code, message, ...extra });
  const preflightIssue = (denied) => {
    if (denied.includes("the repository policy")) return { reason: reason("policy_veto", "The repository policy refused this action.") };
    if (denied.includes("no clearance from")) return { reason: reason("trusted_clearance_required", "Record clearance for the head using the trusted publisher.") };
    if (denied.includes("no trusted clearance")) return { reason: reason("clearance_publisher_required", "Configure the trusted clearance publisher.") };
    if (denied.includes("strict required checks")) {
      const read = runtime.readError("Verify strict required checks and permission to read the branch rules.");
      return { reason: read.code === "insufficient_permission" ? read : reason("strict_checks_unverified", read.message), unknown: true };
    }
    if (denied.includes("held without approval")) return { reason: reason("hold_approval_required", "Separate approval is required for held paths.") };
    if (denied.includes("consent") || denied.includes("paused") || denied.includes("commando is off")) return { reason: reason("paused", "Conveyor is paused.") };
    if (denied.includes("does not report") || denied.includes("cannot be updated")) return { reason: reason("github_not_ready", "GitHub does not report the head ready for this action.") };
    if (/changed|could not be verified|can't read|can't verify|can't compare|couldn't/i.test(denied)) {
      return { reason: runtime.readError("The selected action could not be verified against current GitHub data."), unknown: true };
    }
    return { reason: reason("preflight_blocked", "The selected action failed a write prerequisite. Run conveyor doctor.") };
  };

  const knownInputs = (pr) => {
    if (pr.isDraft === true) return true;
    if (pr.isDraft !== false || typeof pr.isCrossRepository !== "boolean") return false;
    if (pr.mergeable === "CONFLICTING") return true;
    if (pr.mergeable !== "MERGEABLE") return false;
    const rows = checkRows(pr.statusCheckRollup);
    if (!rows || rows.some((row) => isClearedStatus(row, pr.number) && row.state === "SUCCESS" && !Number.isFinite(Date.parse(row.startedAt)))) return false;
    return ciVerdict(rows.filter((row) => !isClearanceContext(row))) !== "unknown";
  };

  const detailsOf = (raw, pr, decision) => {
    const rows = checkRows(raw.statusCheckRollup);
    const checks = (rows ?? []).filter((row) => !isClearanceContext(row) &&
      !(row.__typename === "StatusContext" && isGateContext(row.context))).map((row) => {
      const url = row.detailsUrl ?? row.targetUrl;
      return { name: row.name, state: ciVerdict([row]), ...(typeof url === "string" && /^https:\/\//i.test(url) ? { url } : {}) };
    });
    let state;
    let detail;
    if (raw.state && raw.state !== "OPEN") {
      state = "blocked";
      detail = reason("pr_not_open", "This pull request is no longer open.");
    } else if (raw.baseRefName && raw.baseRefName !== BASE_BRANCH) {
      state = "blocked";
      detail = reason("wrong_base", "This pull request targets a different base.");
    } else if (decision) {
      const { kind, code, message, retryAt } = decision;
      state = ["merge", "update"].includes(kind) ? "ready" : kind;
      detail = reason(code, message, retryAt ? { retryAt } : undefined);
    } else if (pr.kind === "draft") {
      state = "blocked";
      detail = reason("draft", "Mark this pull request ready for review.");
    } else if (pr.kind === "failure") {
      state = "blocked";
      const failed = checks.find((check) => check.state === "red");
      detail = pr.failure === "conflict" ? reason("merge_conflict", "Resolve conflicts with the base.")
        : reason("checks_failed", "Investigate the failing checks.", failed?.url ? { checkUrl: failed.url } : undefined);
    } else if (!knownInputs(raw)) {
      state = "unknown";
      detail = reason("pr_evidence_unavailable", "GitHub has not provided complete check or mergeability data.");
    } else if (pr.kind === "cleared") {
      state = "unknown";
      detail = reason("eligibility_unavailable", "Could not verify eligibility against the base.");
    } else if (checks.some((check) => check.state === "pending")) {
      state = "waiting";
      const pending = checks.find((check) => check.state === "pending");
      detail = reason("checks_pending", "Wait for the checks to finish.", pending.url ? { checkUrl: pending.url } : undefined);
    } else if (!checks.length) {
      state = "waiting";
      detail = reason("checks_missing", "Wait for checks to report on this head.");
    } else {
      state = "blocked";
      detail = reason("clearance_required", "Record clearance for the reviewed head.");
    }
    return {
      entry: { number: pr.number, title: pr.title, url: `https://github.com/${runtime.repo}/pull/${pr.number}`,
        headSha: pr.head, state, position: null, reasons: [detail] },
      checks, checksComplete: rows !== null, holds: decision?.holds ?? [],
    };
  };

  const viewBlockers = ({ sw, dev, stale, ship, pending, state, now }) => {
    const globalBlockers = [];
    if (sw.unreadable) globalBlockers.push(reason("consent_unavailable", "Could not read worker consent."));
    else if (!sw.on) globalBlockers.push(reason("paused", "Conveyor is paused."));
    if (!CLEARANCE_PUBLISHER) globalBlockers.push(reason("clearance_publisher_required", "Configure the trusted clearance publisher."));
    if (pending) globalBlockers.push(reason("write_in_flight", "A previous GitHub write is still being reconciled."));
    if (stale) globalBlockers.push(reason("checkout_not_ready", "The worker checkout must be clean and on the current base tip."));
    if (dev && !dev.green) globalBlockers.push(reason(dev.unreadable ? "base_health_unavailable" : "base_not_green", "The current base tip needs a successful push workflow."));
    if (ship?.blocked) globalBlockers.push(reason(ship.error ? "release_state_unavailable" : "release_in_progress", "The release branch must be clear before writing."));
    if (state.lastMergeAt && now.getTime() - Date.parse(state.lastMergeAt) < DEV_SETTLE_MINUTES * MINUTE) {
      const retryAt = new Date(Date.parse(state.lastMergeAt) + DEV_SETTLE_MINUTES * MINUTE).toISOString();
      globalBlockers.push(reason("base_settling", "Waiting for checks on the last merge.", { retryAt }));
    }
    return globalBlockers;
  };

  const inspectQueue = ({ cwd, dir, run: rawRun, clock }) => {
    const run = readOnlyRun(rawRun);
    const now = clock();
    const { state, corrupt } = readState(join(dir, STATE_NAME));
    if (corrupt) return { error: reason("state_corrupt", "The worker journal is unreadable or unsupported.") };
    const listed = openPrs(run);
    if (listed.error) return { error: listed.error };
    const prs = listed.prs.map(classify);
    const sw = readSwitch(run, dir, now);
    const seen = { why: [], unread: [] };
    const pending = reconcile({ state, now, run, alarm: () => {}, seen });
    const candidates = prs.some((pr) => pr.kind === "cleared");
    const dev = candidates ? devState(run) : undefined;
    const baseTip = dev?.green ? dev : candidates ? devTip(run) : undefined;
    const stale = candidates && sw.on ? cloneProblem(cwd, run) : "";
    const ship = candidates && sw.on ? shipState(run) : undefined;
    const globalBlockers = viewBlockers({ sw, dev, stale, ship, pending, state, now });
    if (listed.incompleteReason) globalBlockers.unshift(listed.incompleteReason);
    const listKnown = listed.complete && listed.prs.every(knownInputs);
    const inputKnown = listKnown && !sw.unreadable && !dev?.unreadable && !baseTip?.error &&
      !stale?.startsWith("can't read") && !ship?.error && seen.unread.length === 0;
    const observations = [];
    let verification;
    let earlierUnknown = false;
    const verify = ({ pr, decision: { kind } }) => {
      const denied = preflight(pr, kind, dev.sha, { cwd, dir, run, clock, preview: true });
      return denied ? { issue: preflightIssue(denied) } : { action: { kind, number: pr.number, headSha: pr.head } };
    };
    if (baseTip?.sha) {
      for (const observation of candidateObservations(prs, state, now, seen.reconciledOpen, { dev: baseTip, dir, run })) {
        observations.push(observation);
        if (observation.decision.kind === "unknown") earlierUnknown = true;
        // Verify the winning merge before spending the remaining budget on later rows.
        if (!verification && !earlierUnknown && inputKnown && globalBlockers.length === 0 && observation.decision.kind === "merge") {
          verification = verify(observation);
        }
      }
    }
    const observed = new Map(observations.map(({ pr, decision }) => [pr.number, decision]));
    const details = new Map(prs.map((pr, i) => [pr.number, detailsOf(listed.prs[i], pr, observed.get(pr.number))]));
    const ranked = ["merge", "update"].flatMap((kind) => observations.filter((item) => item.decision.kind === kind));
    ranked.forEach(({ pr }, index) => { details.get(pr.number).entry.position = index + 1; });
    const entries = [...ranked.map(({ pr }) => details.get(pr.number).entry),
      ...[...details.values()].map(({ entry }) => entry).filter((entry) => entry.position === null).toSorted((a, b) => a.number - b.number)];
    const selected = chooseAction(observations);
    let complete = inputKnown && entries.every((entry) => entry.state !== "unknown");
    let nextActionKnown = (!sw.on && !sw.unreadable) || (inputKnown && (globalBlockers.length > 0 || selected.known));
    let nextAction = null;
    if (nextActionKnown && globalBlockers.length === 0 && selected.selected) {
      const { issue, action } = verification ?? verify(selected.selected);
      if (issue) {
        globalBlockers.push(issue.reason);
        if (issue.unknown) complete = nextActionKnown = false;
      } else nextAction = action;
    }
    if (!complete && !listed.incompleteReason) globalBlockers.push(reason("queue_incomplete", "Some queue evidence is unavailable."));
    return { value: { schemaVersion: 1, repo: runtime.repo, base: BASE_BRANCH, observedAt: now.toISOString(), complete, globalBlockers,
      entries, nextAction, nextActionKnown }, details };
  };

  const inspectExplain = (number, ctx) => {
    const inspected = inspectQueue(ctx);
    if (inspected.error) return inspected;
    const { value: snapshot, details } = inspected;
    let detail = details.get(number);
    if (!detail) {
      const pr = readPull(readOnlyRun(ctx.run), number, ["title", "isDraft", "isCrossRepository", "mergeable", "statusCheckRollup"]);
      if (!pr) return { error: runtime.readError("Could not read that pull request.") };
      detail = detailsOf(pr, classify(pr));
    }
    const entry = detail.entry;
    const nextStep = snapshot.nextAction?.number === number
      ? reason("next_in_queue", `The next tick proposes to ${snapshot.nextAction.kind} this head.`)
      : entry.state === "ready" || entry.state === "unknown"
        ? snapshot.globalBlockers[0] ?? entry.reasons[0] : entry.reasons[0];
    const { entries, ...shared } = snapshot;
    return { value: { ...shared, ...detail, nextStep } };
  };

  const inspectStatus = ({ cwd, dir, run, clock }) => {
    const now = clock();
    const { state, corrupt, legacy } = readState(join(dir, STATE_NAME));
    const sw = readSwitch(run, dir, now);
    const dev = devState(run);
    const stale = cloneProblem(cwd, run);
    const ship = shipState(run);
    const op = state?.operation ?? state?.updating;
    const globalBlockers = viewBlockers({ sw, dev, stale, ship, pending: !!op, state: state ?? {}, now });
    if (corrupt) globalBlockers.unshift(reason("state_corrupt", "The worker journal is unreadable or unsupported."));
    const retryTimes = Object.values(state?.attempts ?? {}).map((at) => Date.parse(at) + MERGE_RETRY_MINUTES * MINUTE).filter((at) => at > now.getTime());
    return { value: { schemaVersion: 1, repo: runtime.repo, base: BASE_BRANCH, stateHealth: corrupt ? "corrupt" : legacy ? "legacy" : "ok",
      lastTickAt: state?.lastTickAt ?? null, lastSuccessfulTickAt: state?.lastSuccessfulTickAt ?? null,
      lastAction: state?.lastAction ?? null, nextRetryAt: retryTimes.length ? new Date(Math.min(...retryTimes)).toISOString() : null,
      operation: op ? { kind: op.kind ?? "update", number: op.number, headSha: op.head, since: op.at } : null,
      consentUntil: sw.on ? sw.value : null, globalBlockers } };
  };

  const inspectDoctor = ({ cwd, dir, run, clock }) => {
    const checks = [];
    const add = (code, ok, message) => checks.push({ code, ok, message });
    const gh = run(["gh", "--version"]);
    add("github_cli", gh.status === 0, gh.status === 0 ? "GitHub CLI is available." : "Install GitHub CLI.");
    const viewer = gh.status === 0 ? runtime.viewer(run) : null;
    if (viewer?.id) add("github_auth", true, "GitHub CLI is authenticated.");
    else if (gh.status === 0) checks.push({ ...runtime.readError("Authenticate GitHub CLI."), ok: false });
    add("trusted_publisher", !!CLEARANCE_PUBLISHER, CLEARANCE_PUBLISHER ? "A clearance publisher is configured." : "Configure the trusted clearance publisher.");
    if (viewer?.id) {
      const dev = devState(run);
      add("base_workflow", dev.green, dev.green ? "The base workflow passed at the current tip." : "Verify the workflow has passed on a push to the current base tip.");
      const strict = hasStrictChecks(run, BASE_BRANCH);
      add("branch_protection", strict, strict ? "Strict required checks are visible." : "Verify strict required checks and permission to read the branch rules.");
      const stale = cloneProblem(cwd, run);
      add("worker_checkout", !stale, stale ? "Use a clean checkout on the current base tip." : "The checkout is clean and current.");
    }
    const sw = readSwitch(run, dir, clock());
    add("consent_state", !sw.unreadable, sw.unreadable ? "The consent file could not be read." : sw.on ? "Worker consent is active." : "The worker is paused.");
    const { corrupt } = readState(join(dir, STATE_NAME));
    add("worker_journal", !corrupt, corrupt ? "The worker journal is unreadable or unsupported." : "The worker journal is readable.");
    return { value: { repo: runtime.repo, base: BASE_BRANCH, healthy: checks.every((check) => check.ok), checks } };
  };

  const clearExact = ({ number, headSha }, { run }) => {
    if (!CLEARANCE_PUBLISHER) return { error: reason("invalid_config", "Configure the trusted clearance publisher before clearing a head.") };
    const viewer = runtime.viewer(run);
    if (!viewer) return { error: runtime.readError("Could not verify the authenticated publisher.") };
    if (viewer.id !== CLEARANCE_PUBLISHER) return { error: reason("insufficient_permission", "The authenticated user is not the configured clearance publisher.") };
    const verifyTarget = () => {
      const pr = readPull(run, number);
      if (!pr) return runtime.readError("Could not read that pull request.");
      if (pr.state !== "OPEN" || pr.baseRefName !== BASE_BRANCH) return reason("invalid_target", "Clearance requires an open pull request targeting the configured base.");
      if (pr.headRefOid !== headSha) return reason("head_changed", "The pull request head has changed. Review the new head before clearing it.");
    };
    const problem = verifyTarget();
    if (problem) return { error: problem };
    const context = clearanceContext(number);
    const existing = runtime.latestClearance(run, headSha, context);
    if (existing.error) return { error: existing.error };
    if (existing.status?.state === "success" && existing.status.creator?.id === CLEARANCE_PUBLISHER) {
      return { value: { kind: "already_cleared", number, headSha } };
    }
    const moved = verifyTarget();
    if (moved) return { error: moved };
    if (postCleared(run, number, headSha, "Reviews passed at this head")) {
      const failure = runtime.readError("Could not record clearance for this head.");
      if (["missing_auth", "insufficient_permission", "not_found", "rate_limited", "missing_github_cli", "read_budget_exhausted"].includes(failure.code)) {
        return { error: failure };
      }
    }
    const reconciled = runtime.latestClearance(run, headSha, context);
    if (!reconciled.error && reconciled.status?.state === "success" && reconciled.status.creator?.id === CLEARANCE_PUBLISHER) {
      return { value: { kind: "cleared", number, headSha } };
    }
    return { value: { kind: "unknown", number, headSha,
      reason: reason("write_unconfirmed", "GitHub has not confirmed the clearance write. Check this head's clearance before retrying.") } };
  };

  const executeTick = async (ctx) => {
    const release = takeLock(join(ctx.dir, LOCK_NAME));
    if (!release) return { value: { kind: "blocked", reason: reason("worker_locked", "Another tick is running or the lock needs attention.") } };
    let releaseConsent;
    let seen;
    try {
      // Even workers with different journal names share this consent file.
      releaseConsent = runtime.lockConsent();
      if (!releaseConsent) return { value: { kind: "blocked", reason: reason("operator_locked", "A worker tick or consent change is running. Retry after it finishes.") } };
      const code = await tick({ ...ctx, observe: (value) => { seen = value; } });
      if (seen?.corrupt) return { error: reason("state_corrupt", "The worker journal is unreadable or unsupported.") };
      if (seen?.outcome) return { value: seen.outcome };
      if (seen?.submitted) {
        const { kind, number, head } = seen.submitted;
        return { value: { kind: "unknown", action: { kind, number, headSha: head },
          reason: reason("write_unconfirmed", "GitHub has not confirmed the write. Conveyor will reconcile it before retrying.") } };
      }
      if (seen?.switch?.unreadable) return { error: reason("consent_unavailable", "Could not read worker consent.") };
      if (code !== 0 || seen?.unread?.length) return { error: runtime.readError("The tick could not verify the data needed to act.") };
      if (!seen?.switch?.on) return { value: { kind: "blocked", reason: reason("paused", "Conveyor is paused.") } };
      if (seen.preflight) {
        const issue = preflightIssue(seen.preflight);
        return issue.unknown ? { error: issue.reason } : { value: { kind: "blocked", reason: issue.reason } };
      }
      if (seen.blocked) return { value: { kind: "blocked", reason: reason("write_blocked", "The tick was blocked by a write prerequisite. Run conveyor status.") } };
      return { value: { kind: "idle", reason: reason("no_action", "No action was selected.") } };
    } catch (error) {
      if (seen?.submitted) {
        const { kind, number, head } = seen.submitted;
        return { value: { kind: "unknown", action: { kind, number, headSha: head },
          reason: reason("write_unconfirmed", "GitHub has not confirmed the write. Conveyor will reconcile it before retrying.") } };
      }
      throw error;
    } finally {
      releaseConsent?.();
      release();
    }
  };

  const USAGE = "usage: conveyor.mjs tick [--dry-run] | status | report [--days N] | clear <pr> <head sha>";

  // Returns the exit code: 0 done, 1 gh failed or refused, 2 usage, 3 a tick failed and alarmed.
  const main = async (argv, { cwd = process.cwd(), run = (argv, timeout) => defaultRun(argv, timeout, cwd), clock = () => new Date(), out = console.log, err = console.error, env = process.env, hook = defaultHook, wrangle = wrangleMerge } = {}) => {
    const [command, ...rest] = argv;
    if (!["tick", "status", "report", "clear"].includes(command)) {
      err(USAGE);
      return 2;
    }
    if (command === "clear") {
      const [number, head] = rest;
      if (rest.length !== 2 || !/^[1-9]\d*$/.test(number) || !isSha(head)) {
        err(`${USAGE}\nconveyor: clear takes a PR number and the head SHA that was reviewed`);
        return 2;
      }
      return clear(number, head, { run, out, err });
    }
    if (command === "report") {
      const days = rest.length === 0 ? REPORT_DAYS : Number(rest[1]);
      if ((rest.length !== 0 && (rest.length !== 2 || rest[0] !== "--days")) || !(days > 0)) {
        err(`${USAGE}\nconveyor: --days takes a number above 0`);
        return 2;
      }
      out(switchLine(readSwitch(run)));
      const report = reportLine(cwd, run, clock(), days);
      if (report.error) {
        err(`conveyor: ${report.error}`);
        return 1;
      }
      out(report.line);
      return 0;
    }
    // Only this exact flag: anything else on a tick, `--dryrun` included, is refused, never run as a real one.
    const dry = command === "tick" && rest.length === 1 && rest[0] === "--dry-run";
    if (rest.length > 0 && !dry) {
      err(USAGE);
      return 2;
    }
    let dir;
    try {
      dir = gitDir(run, cwd);
    } catch (error) {
      err(`conveyor: ${error.message}`);
      return 1;
    }
    if (command === "status") return status({ cwd, run, now: clock(), out, err, dir });
    // No lock: a dry run writes nothing, so it has nothing to contend over, even with a real tick running.
    if (dry) return tick({ cwd, run, clock, out, err, env, hook, wrangle, dir, dry });
    // One tick at a time, so a long merge and a hand-run can't land two PRs side by side.
    let release;
    try {
      release = takeLock(join(dir, LOCK_NAME));
      if (!release) {
        out("conveyor: another tick is running or the lock needs attention");
        return 0;
      }
      return await tick({ cwd, run, clock, out, err, env, hook, wrangle, dir });
    } catch (error) {
      err(`conveyor: tick could not finish: ${error.message}`);
      return 1;
    } finally {
      release?.();
    }
  };


  const legacy = { CLEARED_CONTEXT, ENABLED_VARIABLE, ENABLED_VALUE, COMMANDO_WARN_HOURS, MERGE_WAIT_MINUTES, DEV_SETTLE_MINUTES, DEV_STUCK_MINUTES, MERGE_RETRY_MINUTES, UPDATE_FLIGHT_MINUTES, LOCK_HUNG_MINUTES, REPORT_DAYS, OUTBOX_MAX, RUN_TIMEOUT_MS, STATE_NAME, LOG_NAME, LOCK_NAME, defaultRun, readsOnly, classify, readSwitch, devState, staleness, percentile, reportLine, readOnlyRun, main };
  return runtime ? { inspectQueue, inspectExplain, inspectStatus, inspectDoctor, executeTick, clearExact, reportLine } : legacy;
};

export const createConveyor = (config) => createWorker(config);
