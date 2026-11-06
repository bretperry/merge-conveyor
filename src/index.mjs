// Configured conveyor tick, clearance, status and reporting.
// Used by: the conveyor CLI and the package tests.
// Exports: createConveyor.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { latestPerCheck } from "./merge-checks.mjs";
import { ciVerdict } from "./ci.mjs";
const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const short = (sha) => (sha || "?").slice(0, 7);

// Rename is atomic, so a crash mid-write can't leave half a file for the next tick to read.
const writeAtomic = (path, text) => {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, text);
  renameSync(temp, path);
};

// Nearest-rank percentile of a list of numbers.
const percentile = (values, p) => values.toSorted((a, b) => a - b)[Math.ceil((p / 100) * values.length) - 1];

const minutes = (value) => (value < 120 ? `${Math.round(value)}m` : `${(value / 60).toFixed(1)}h`);

const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists, under another user.
    return error.code === "EPERM";
  }
};

const lockText = (now) => JSON.stringify({ pid: process.pid, at: now.toISOString() });

const hourOf = (now) => now.toISOString().slice(0, 13);

// Every PR's state and base, for approvedWork's "merged counts as on dev". One call, and only when a
// plan has approved work to check. Null when the read failed: an unknown PR would read as not on dev.
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
  object(config.release, "release");
  string(config.release.branch, "release.branch");
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

export const createConveyor = (config) => {
  validateConfig(config);
  const { approved, changeDigest, gitDir, heldDigest, readHeld, activeUntil, commando, DOCS_ONLY, heldBy, isGateContext, wrangleMerge, approvedWork, approvalClock } = config.adapters;
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
  // GitHub's compare API lists at most this many files, so a list this long may hide a code path.
  const COMPARE_MAX_FILES = 300;
  // A live PID that hasn't beaten for this long is a reused PID or a hung tick.
  const LOCK_HUNG_MINUTES = 120;
  const LOCK_BEAT_MS = 30_000;
  const REPORT_DAYS = 7;
  // The target this repo's flow is measured against: approved to on dev.
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
  // A commit GitHub starts no run for; the same markers the guard reads.
  const SKIPS_CI = /\[(skip ci|ci skip|no ci|skip actions|actions skip)\]|skip-checks:\s*true/i;
  // `tick`'s code once it has alarmed, so the shell wrapper only reports a tick that couldn't.
  const REPORTED = 3;

  const HOUR = 3600 * 1000;
  const MINUTE = 60 * 1000;

  const defaultRun = (argv, timeout = RUN_TIMEOUT_MS) => {
    const result = spawnSync(argv[0], argv.slice(1), { encoding: "utf8", timeout });
    return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr || (result.error?.message ?? "") };
  };

  // Runs an owner's command. Data goes in on stdin and env, never into the command line, because a PR
  // title or check name is text anyone with a branch can choose. Returns "" or what went wrong.
  const defaultHook = (command, input, env) => {
    const result = spawnSync("/bin/sh", ["-c", command], { input, env, encoding: "utf8", timeout: HOOK_TIMEOUT_MS });
    if (result.error) return result.error.message;
    return result.status === 0 ? "" : result.stderr.trim() || `exit ${result.status}`;
  };

  // Whether a command only reads. `gh api` writes when given a method, a field or a body; the other
  // `gh` verbs are listed by name, so a new one is refused until someone decides it reads.
  const GH_READS = new Set(["pr list", "pr view", "run list"]);
  const GH_API_WRITES = /^(-X|--method|-f|-F|--field|--raw-field|--input)/;
  const readsOnly = (argv) => argv[0] !== "gh" || GH_READS.has(argv.slice(1, 3).join(" ")) || (argv[1] === "api" && !argv.some((arg) => GH_API_WRITES.test(arg)));




  // The real status only: a check run anyone's workflow can name the same, and it isn't a review's mark.
  const isClearedStatus = ({ __typename: type, context }) => type === "StatusContext" && context === CLEARED_CONTEXT;

  // One PR's class from its own fields. The real gate is commando's merge; this only decides whether to try.
  //   failure   a red check or a conflict on a PR that is ready or cleared: a session must act
  //   draft     not asked to land yet     reviews   ready, but no cleared status on this head
  //   running   cleared, checks going     cleared   cleared and green: try to merge
  const classify = (pr) => {
    // A review gate is a status, not CI: commando's merge reads those, and this says nothing about them.
    const rows = latestPerCheck((pr.statusCheckRollup ?? []).filter(({ __typename: type, context }) => !(type === "StatusContext" && isGateContext(context))).map((row) => ({ ...row, name: row.name || row.context, workflow: row.workflowName })));
    const status = rows.find(isClearedStatus);
    const clearedRow = status?.state === "SUCCESS" ? status : null;
    const checks = rows.filter((row) => !isClearedStatus(row));
    const failing = rows.filter((row) => ciVerdict([row]) === "red").map((row) => row.name);
    const checksDone = checks.length > 0 && checks.every((row) => ciVerdict([row]) !== "pending");
    const base = { number: pr.number, title: pr.title ?? "", head: pr.headRefOid ?? "", clearedAt: clearedRow?.startedAt ?? null, fork: pr.isCrossRepository !== false, checksDone };
    const pushed = !pr.isDraft || Boolean(clearedRow);
    if (pushed && failing.length > 0) return { ...base, kind: "failure", failure: "failing", detail: failing.join(", ") };
    if (pushed && pr.mergeable === "CONFLICTING") return { ...base, kind: "failure", failure: "conflict", detail: `conflicts with ${BASE_BRANCH}` };
    if (pr.isDraft) return { ...base, kind: "draft", detail: clearedRow ? "cleared, but still a draft: its heavy checks haven't run" : "draft" };
    if (!clearedRow) return { ...base, kind: "reviews", detail: "ready; no cleared status on this head" };
    if (checks.length === 0 || checks.some((row) => ciVerdict([row]) !== "green")) return { ...base, kind: "running", detail: "cleared; checks still running" };
    return { ...base, kind: "cleared", detail: "cleared and green" };
  };

  // Whether the switch reads `on`. A 404 is "not set"; any other failure (a 502, a timeout, no network) is
  // a read that failed, which alarms where an off or unset switch does not. Needs Variables: read.
  const readSwitch = (run) => {
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
    const result = run(["gh", "api", `repos/{owner}/{repo}/commits/${BASE_BRANCH}`, "--jq", ".sha"]);
    const sha = result.stdout.trim();
    return result.status === 0 && sha ? { sha } : { error: `can't read ${BASE_BRANCH}'s tip: ${result.stderr.trim() || "bad output"}` };
  };

  // Whether `dev` is green now: its CI workflow's last push run succeeded, at the tip or with only
  // skip-ci commits above it. No run reads as not green: a dev that never runs CI can't say it's green.
  const devState = (run) => {
    const result = run(["gh", "run", "list", "--branch", BASE_BRANCH, "--event", "push", "--workflow", DEV_WORKFLOW, "--limit", "1", "--json", "status,conclusion,headSha"]);
    const runs = result.status === 0 ? parseJson(result.stdout) : null;
    if (!Array.isArray(runs)) return { green: false, unreadable: true, why: `can't read ${BASE_BRANCH}'s runs: ${result.stderr.trim() || "bad output"}` };
    if (runs.length === 0) return { green: false, why: `${BASE_BRANCH} has no ${DEV_WORKFLOW} run on a push` };
    const [last] = runs;
    if (last.status !== "completed") return { green: false, why: `${BASE_BRANCH}'s run at ${short(last.headSha)} is still going (${last.status})` };
    if (last.conclusion !== "success") return { green: false, red: last.headSha, why: `${BASE_BRANCH}'s run at ${short(last.headSha)} ended ${last.conclusion}` };
    const tip = devTip(run);
    if (tip.error) return { green: false, unreadable: true, why: tip.error };
    if (tip.sha === last.headSha) return { green: true };
    const compare = run(["gh", "api", `repos/{owner}/{repo}/compare/${last.headSha}...${BASE_BRANCH}`, "--jq", "[.commits[].commit.message]"]);
    const messages = compare.status === 0 ? parseJson(compare.stdout) : null;
    if (!Array.isArray(messages)) return { green: false, unreadable: true, why: `can't compare ${BASE_BRANCH}'s tip with its last run: ${compare.stderr.trim() || "bad output"}` };
    return messages.every((message) => SKIPS_CI.test(message)) ? { green: true } : { green: false, why: `${BASE_BRANCH}'s tip ${short(tip.sha)} has no finished ${DEV_WORKFLOW} run yet` };
  };

  // Whether `dev` has moved outside the docs-only list since this head's merge-base, so its CI never ran
  // against what it would land on. A rename counts under either name. A list that may be cut short, or
  // commits with no list, count as moved; anything unreadable is an error, never "not stale".
  const staleness = (head, run) => {
    const result = run(["gh", "api", `repos/{owner}/{repo}/compare/${head}...${BASE_BRANCH}`, "--jq", "[.ahead_by, [.files[] | [.filename, .previous_filename // \"\"]]]"]);
    const read = result.status === 0 ? parseJson(result.stdout) : null;
    if (!Array.isArray(read) || !Number.isInteger(read[0]) || !Array.isArray(read[1])) return { error: `can't compare ${short(head)} with ${BASE_BRANCH}: ${result.stderr.trim() || "bad output"}` };
    const [ahead, files] = read;
    if (ahead === 0) return { stale: false };
    if (files.length === 0 || files.length >= COMPARE_MAX_FILES) return { stale: true, why: `${BASE_BRANCH} moved and the compare can't list every file` };
    const code = files.flat().find((path) => path && !DOCS_ONLY.test(path));
    return code ? { stale: true, why: `${BASE_BRANCH} moved in ${code}` } : { stale: false };
  };

  // The ship freeze: a push to `dev` moves the open ship PR's head and cancels its checks.
  const shipState = (run) => {
    const result = run(["gh", "pr", "list", "--base", SHIP_BRANCH, "--head", BASE_BRANCH, "--state", "open", "--json", "number"]);
    const open = result.status === 0 ? parseJson(result.stdout) : null;
    if (!Array.isArray(open)) return { blocked: true, error: true, why: `can't tell whether a ship PR is open: ${result.stderr.trim() || "bad output"}` };
    return open.length > 0 ? { blocked: true, why: `ship PR #${open[0].number} is open, so ${BASE_BRANCH} is frozen` } : { blocked: false };
  };

  // Why this clone can't be trusted to merge, or "". The hold list and the merge path run from its
  // files with the token, so it must be exactly `dev`'s tip: not another branch, not behind, not edited.
  const cloneProblem = (cwd, run) => {
    const branch = run(["git", "-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();
    if (branch !== BASE_BRANCH) return `this clone is on ${branch || "no branch"}, not ${BASE_BRANCH}`;
    // No optional locks: a plain `git status` may refresh the index, and a dry run must write nothing.
    if (run(["git", "--no-optional-locks", "-C", cwd, "status", "--porcelain"]).stdout.trim()) return "this clone has uncommitted changes";
    const tip = devTip(run);
    if (tip.error) return tip.error;
    const local = run(["git", "-C", cwd, "rev-parse", "HEAD"]).stdout.trim();
    return local === tip.sha ? "" : `this clone is at ${short(local)}, which isn't ${BASE_BRANCH}'s tip ${short(tip.sha)}`;
  };

  // The hold classes still open for this PR, or the read's error, kept apart: a failed read says nothing
  // about holds. An early look only, so a hold costs one alarm instead of a log line in commando's
  // report every 5 minutes; commando re-reads it at the merge.
  const holdsNow = (dir, number, now, run) => {
    const state = readHeld(String(number), run);
    return state.error ? { error: state.error } : { classes: openHolds(dir, number, now, state) };
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
      const start = notes.get(pr.number) ?? pr.statusCheckRollup?.find(isClearedStatus)?.startedAt;
      return (Date.parse(pr.mergedAt) - Date.parse(start)) / MINUTE;
    });
    // NaN is no clock; below zero is a note written after the merge, which measures nothing.
    const clocked = spans.filter((span) => span >= 0);
    const window = `${since.toISOString().slice(0, 10)} to ${now.toISOString().slice(0, 10)}`;
    const times = clocked.length > 0 ? `approved to on dev p50 ${minutes(percentile(clocked, 50))}, p90 ${minutes(percentile(clocked, 90))}` : "no approval times";
    return { line: `${basename(cwd)} ${window}: ${inWindow.length} merged, ${times} (target p50 ${minutes(TARGET_P50_MINUTES)}, p90 ${minutes(TARGET_P90_MINUTES)}), ${inWindow.length - clocked.length} with no clock` };
  };

  // `corrupt`: the file is there but unreadable. Its marks only repeat alarms, but the last merge's
  // time may be in it too, so the tick that finds it doesn't merge.
  const readState = (dir) => {
    const path = join(dir, STATE_NAME);
    const saved = existsSync(path) ? parseJson(readFileSync(path, "utf8")) : {};
    return { state: { alarmed: {}, hooked: {}, attempts: {}, outbox: [], outboxDropped: 0, voided: {}, ...saved }, corrupt: saved === null };
  };

  const writeState = (dir, state, now) => {
    const keep = now.getTime() - STATE_KEEP_DAYS * 24 * HOUR;
    const fresh = (map) => Object.fromEntries(Object.entries(map).filter(([, at]) => Date.parse(at) >= keep));
    const pruned = { ...state, alarmed: fresh(state.alarmed), hooked: fresh(state.hooked), attempts: fresh(state.attempts) };
    writeAtomic(join(dir, STATE_NAME), `${JSON.stringify(pruned, null, 2)}\n`);
  };



  // True when this tick now holds the lock. A tick that died gives it up at once; a live one keeps it
  // however long its merge runs, unless it has stopped beating (its PID was reused, or it hung).
  const takeLock = (path, now) => {
    try {
      if (existsSync(path)) {
        const text = readFileSync(path, "utf8");
        const holder = parseJson(text);
        if (holder && pidAlive(holder.pid) && now.getTime() - Date.parse(holder.at) < LOCK_HUNG_MINUTES * MINUTE) return false;
        // Two ticks can both read it as stale. A rename lets one retire it; a tick that catches a newer
        // lock instead, because the other already took over, puts it back and stands down.
        const aside = `${path}.${process.pid}.stale`;
        renameSync(path, aside);
        if (readFileSync(aside, "utf8") !== text) {
          renameSync(aside, path);
          return false;
        }
        rmSync(aside);
      }
      writeFileSync(path, lockText(now), { flag: "wx" });
      return true;
    } catch {
      return false;
    }
  };

  const openPrs = (run) => {
    const result = run(["gh", "pr", "list", "--state", "open", "--base", BASE_BRANCH, "--limit", LIST_LIMIT, "--json", "number,title,isDraft,isCrossRepository,headRefOid,mergeable,statusCheckRollup"]);
    const prs = result.status === 0 ? parseJson(result.stdout) : null;
    return Array.isArray(prs) ? { prs } : { error: `can't list open PRs: ${result.stderr.trim() || "bad output"}` };
  };

  // The merge itself: commando's own `merge`, so its switch, base rule, holds, pinned head and every
  // wrangle-merge check all apply. The wrapper adds what a timer needs: the head commando pinned must be
  // the head that was cleared, the wait is shorter, and `lastLook` runs right before `gh pr merge`.
  const commandoMerge = (pr, { cwd, run, now, out, err, wrangle, lastLook }) =>
    commando(["merge", String(pr.number)], {
      cwd,
      run,
      now,
      out,
      err,
      merge: (args, options) => {
        if (options.wantHead !== pr.head) {
          err(`conveyor: #${pr.number} moved to ${short(options.wantHead)} after ${short(pr.head)} was cleared; refusing`);
          return 1;
        }
        return wrangle(["--wait-minutes", String(MERGE_WAIT_MINUTES), ...args], { ...options, run, beforeMerge: () => lastLook(pr) });
      },
    });



  // Reads `dev`'s CI and alarms on it, every tick: a red `dev` matters with no PR waiting and commando off too.
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

  // After an update's head has moved: the clearance follows if the PR's own diff didn't change, and a held
  // yes stands or falls by approve.mjs's rule. True once this head is settled; false to try again next tick.
  const carryClearance = (pr, flight, { state, alarm, dir, now, run, act, seen }) => {
    const after = readHeld(String(pr.number), run, { allModes: true });
    if (after.error) {
      alarm(`carry-read:${pr.number}:${hourOf(now)}`, `${after.error}, so #${pr.number}'s clearance can't follow its update yet. (${pr.title})`);
      seen.unread.push(after.error);
      return false;
    }
    if (after.head !== pr.head) return false;
    const digest = changeDigest(after.files);
    const same = digest !== null && digest === flight.digest;
    const diffNote = digest ? "own diff changed" : "own diff can't be fingerprinted";
    const classes = openHolds(dir, pr.number, now, after);
    if (classes.length > 0) {
      state.voided[`${pr.number}@${pr.head}`] = { classes, at: now.toISOString() };
      alarm(`held:${pr.number}@${pr.head}`, `#${pr.number}'s update from ${BASE_BRANCH} voided your yes for ${classes.join(", ")}: \`pnpm approve ${pr.number}\` in this clone after a look.${same ? "" : ` Its ${diffNote} too, so it needs a new review.`} (${pr.title})`);
    } else if (!same) {
      alarm(`carry:${pr.number}@${pr.head}`, `#${pr.number}'s ${diffNote} in its update from ${BASE_BRANCH}, so its clearance did not follow: it needs a new review, then \`conveyor clear\`. (${pr.title})`);
    }
    if (!same || pr.clearedAt) return true;
    const problem = act.repost(pr, flight.head);
    if (problem) alarm(`carry-post:${pr.number}@${pr.head}`, `can't re-post ${CLEARED_CONTEXT} on #${pr.number} at ${short(pr.head)}: ${problem}. (${pr.title})`);
    return !problem;
  };

  // Whether the one update in flight still holds the queue: until its head has moved and its CI has
  // finished, whatever came of its clearance, so no other PR is touched while it spends runners.
  const updateInFlight = (context) => {
    const { prs, state, alarm, now, seen } = context;
    const flight = state.updating;
    if (!flight) return false;
    const pr = prs.find((p) => p.number === flight.number);
    if (!pr) {
      delete state.updating;
      return false;
    }
    const moved = pr.head !== flight.head;
    if (moved && !flight.settled) flight.settled = carryClearance(pr, flight, context);
    if (moved && flight.settled && pr.checksDone) {
      delete state.updating;
      return false;
    }
    if (now.getTime() - Date.parse(flight.at) >= UPDATE_FLIGHT_MINUTES * MINUTE) {
      alarm(`update-stuck:${pr.number}@${pr.head}`, `#${pr.number}'s update from ${BASE_BRANCH} is still ${moved ? "not settled" : "not on its head"} after ${UPDATE_FLIGHT_MINUTES} minutes; the queue goes on without it. (${pr.title})`);
      delete state.updating;
      return false;
    }
    seen.why.push(`#${pr.number}'s update from ${BASE_BRANCH} is still in flight`);
    return true;
  };

  // Updates one stale PR, its digest and the in-flight mark saved first: a crash mid-update still holds the queue, and the digest is what lets its clearance follow.
  const startUpdate = (pr, { state, alarm, now, run, act, save, seen }) => {
    const key = `${pr.number}@${pr.head}`;
    state.attempts[`update:${key}`] = now.toISOString();
    const before = readHeld(String(pr.number), run, { allModes: true });
    const digest = before.error ? null : changeDigest(before.files);
    if (!digest || before.head !== pr.head) {
      alarm(`update-read:${key}`, `#${pr.number} is stale, but ${before.error ?? `its change at ${short(pr.head)} can't be fingerprinted`}, so it wasn't updated: its clearance couldn't follow. (${pr.title})`);
      if (before.error) seen.unread.push(before.error);
      return;
    }
    state.updating = { number: pr.number, head: pr.head, digest, at: now.toISOString() };
    save(now);
    const problem = act.update(pr);
    if (!problem) return;
    delete state.updating;
    if (/conflict/i.test(problem)) alarm(`failure:${key}:conflict`, `#${pr.number} at ${short(pr.head)}: conflicts with ${BASE_BRANCH}. It needs a session. (${pr.title})`);
    else alarm(`update:${key}`, `#${pr.number}'s update from ${BASE_BRANCH} failed: ${problem}; retrying in ${MERGE_RETRY_MINUTES} minutes. (${pr.title})`);
  };

  // At most one merge or update per tick, the oldest cleared first, a PR already current before any stale one, with `dev` green and no ship open before it.
  // `land` makes the merge (a dry run's only records it); `seen` gets the reasons nothing landed, for a dry run to print.
  const mergeOne = async ({ prs, dev, state, alarm, dir, now, run, clock, land, act, save, seen }) => {
    if (updateInFlight({ prs, state, alarm, dir, now, run, act, seen })) return;
    const retryAfter = now.getTime() - MERGE_RETRY_MINUTES * MINUTE;
    const candidates = prs
      .filter((pr) => pr.kind === "cleared" && !(Date.parse(state.attempts[`${pr.number}@${pr.head}`]) > retryAfter))
      .toSorted((a, b) => Date.parse(a.clearedAt) - Date.parse(b.clearedAt));
    if (candidates.length === 0) {
      seen.why.push("no PR is cleared, green and past its retry wait");
      return;
    }
    if (state.lastMergeAt && now.getTime() - Date.parse(state.lastMergeAt) < DEV_SETTLE_MINUTES * MINUTE) {
      seen.why.push(`the last merge was under ${DEV_SETTLE_MINUTES} minutes ago`);
      return;
    }
    const ship = shipState(run);
    if (ship.blocked) {
      if (ship.error) {
        alarm(`ship:${hourOf(now)}`, `${ship.why}. Nothing merges until it can tell.`);
        seen.unread.push(ship.why);
      }
      seen.why.push(ship.why);
      return;
    }
    if (!dev.green) {
      seen.why.push(dev.why);
      return;
    }
    // Everything that can change during the wait, read again right before `gh pr merge`. An approval can
    // run out in the wait too: wrangle-merge needs a minute of stable polls after commando has read it.
    const lastLook = (pr) => {
      const at = clock();
      // The switch first: an owner who stops the conveyor during the wait stops this merge too.
      const switchNow = readSwitch(run);
      if (!switchNow.on) return switchNow.why;
      if (!activeUntil(dir, at)) return "commando is off";
      const shipNow = shipState(run);
      if (shipNow.blocked) return shipNow.why;
      const devNow = devState(run);
      if (!devNow.green) return devNow.why;
      const holds = holdsNow(dir, pr.number, at, run);
      if (holds.error) return holds.error;
      if (holds.classes.length > 0) return `held, with no approval in force (${holds.classes.join(", ")})`;
      const moved = staleness(pr.head, run);
      return moved.error ?? (moved.stale ? `#${pr.number} is stale: ${moved.why}` : "");
    };
    let toUpdate = null;
    for (const pr of candidates) {
      const holds = holdsNow(dir, pr.number, now, run);
      if (holds.error) {
        alarm(`hold-read:${pr.number}:${hourOf(now)}`, `${holds.error}, so #${pr.number} waits. (${pr.title})`);
        seen.unread.push(holds.error);
        seen.why.push(`#${pr.number} waits: ${holds.error}`);
        continue;
      }
      if (holds.classes.length > 0) {
        alarm(`held:${pr.number}@${pr.head}`, `#${pr.number} is cleared and green but waits for you (${holds.classes.join(", ")}): \`pnpm approve ${pr.number}\` in this clone. (${pr.title})`);
        seen.why.push(`#${pr.number} is held (${holds.classes.join(", ")}) with no approval in force`);
        continue;
      }
      const moved = staleness(pr.head, run);
      if (moved.error) {
        alarm(`stale-read:${pr.number}:${hourOf(now)}`, `${moved.error}, so #${pr.number} waits. (${pr.title})`);
        seen.unread.push(moved.error);
        seen.why.push(`#${pr.number} waits: ${moved.error}`);
        continue;
      }
      if (moved.stale) {
        seen.why.push(`#${pr.number} is stale: ${moved.why}`);
        if (pr.fork) alarm(`fork:${pr.number}@${pr.head}`, `#${pr.number} is stale (${moved.why}) and comes from a fork, so the conveyor can't update it. It needs a session. (${pr.title})`);
        else if (!(Date.parse(state.attempts[`update:${pr.number}@${pr.head}`]) > retryAfter)) toUpdate ??= pr;
        continue;
      }
      state.attempts[`${pr.number}@${pr.head}`] = now.toISOString();
      const code = await land(pr, lastLook);
      if (code === 0) state.lastMergeAt = clock().toISOString();
      else alarm(`merge:${pr.number}@${pr.head}`, `#${pr.number}'s merge at ${short(pr.head)} did not land (exit ${code}); retrying in ${MERGE_RETRY_MINUTES} minutes. (${pr.title})`);
      return;
    }
    if (toUpdate) startUpdate(toUpdate, { state, alarm, now, run, act, save, seen });
  };

  // One pass. Alarms and marks go through `tell`, `alarm` and `state`, which `tick` owns.
  const pass = async ({ cwd, run, clock, env, hook, dir, now, state, corrupt, tell, alarm, save, land, act, seen, dry }) => {
    state.lastTickAt = now.toISOString();

    const stale = cloneProblem(cwd, run);
    if (stale) alarm(`stale:${hourOf(now)}`, `${stale}. Nothing merges from here until it is on ${BASE_BRANCH}'s tip.`);
    if (stale.startsWith("can't read")) seen.unread.push(stale);

    const until = activeUntil(dir, now);
    Object.assign(seen, { stale, until });
    if (until && until.getTime() - now.getTime() <= COMMANDO_WARN_HOURS * HOUR) alarm(`commando-ending:${until.toISOString()}`, `commando ends at ${until.toISOString()}. \`pnpm commando on <hours>\` in this clone keeps the merges going.`);

    const dev = watchDev({ run, now, state, alarm });
    seen.dev = dev;
    if (dev.unreadable) seen.unread.push(dev.why);

    const listed = openPrs(run);
    if (listed.error) {
      alarm(`gh:${hourOf(now)}`, listed.error);
      seen.unread.push(listed.error);
      seen.why.push("the open PRs couldn't be read");
      return REPORTED;
    }
    const prs = listed.prs.map(classify);
    seen.prs = prs;
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

    seen.blocked = !until ? "commando is off in this clone" : stale || (corrupt ? "its state file is unreadable" : "");
    // A dry run goes on past what would stop a tick, to say which PR it would have merged.
    if (!seen.blocked || dry) await mergeOne({ prs, dev, state, alarm, dir, now, run, clock, land, act, save, seen });
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
    out(`clone: ${stale?.startsWith("can't read") ? "?" : stale || "on dev's tip"}`);
    out(`${BASE_BRANCH}: ${!dev ? "not read" : dev.green ? "green" : dev.unreadable ? "?" : `not green: ${dev.why}`}`);
    out(`open PRs: ${prs ? prs.length : "?"}`);
    for (const pr of prs ?? []) out(`  #${pr.number} ${pr.kind} at ${short(pr.head)}: ${pr.detail}`);
    if (queued > 0) out(`${queued} queued alarm${queued === 1 ? "" : "s"} would be sent first`);
    out(alarms.length > 0 ? `would send ${alarms.length} alarm${alarms.length === 1 ? "" : "s"}:` : "would send no alarms");
    for (const line of alarms) out(`  ${line}`);
    for (const line of hooks) out(`would run CONVEYOR_ON_FAILURE_COMMAND: ${line}`);
    for (const text of seen.unread) out(`? ${text}`);
    if (seen.carry) out(`would re-post ${CLEARED_CONTEXT} on #${seen.carry.number} at ${short(seen.carry.head)}: its own diff is unchanged`);
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
  const tick = async ({ cwd, dir, clock, out, err, env, hook, dry = false, wrangle, run: realRun }) => {
    const now = clock();
    const run = dry ? readOnlyRun(realRun) : realRun;
    // First, before any other read: the switch decides whether anything else happens.
    const enabled = readSwitch(run);
    const { state, corrupt } = readState(dir);
    const seen = { switch: enabled, why: [], unread: [], merge: null, blocked: "" };
    const alarms = [];
    const hooks = [];
    const logLine = (line) => appendFileSync(join(dir, LOG_NAME), `${clock().toISOString()} ${line}\n`);
    const save = (at) => {
      if (!dry) writeState(dir, state, at);
    };
    // One try per tick at a command that is down: each can take a minute, and the queue may be long.
    let down = false;
    const deliver = (line) => {
      if (down) return false;
      const problem = env.CONVEYOR_ALARM_COMMAND ? hook(env.CONVEYOR_ALARM_COMMAND, `${line}\n`, env) : "";
      if (!problem) return true;
      down = true;
      err(`conveyor: CONVEYOR_ALARM_COMMAND failed: ${problem}`);
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
    // The merge, and the failure hook: a dry run only notes that each would have happened.
    const land = dry ? async (pr) => ((seen.merge = pr), 0) : (pr, lastLook) => commandoMerge(pr, { cwd, run, now: clock(), out, err, wrangle, lastLook });
    // The update and the re-post: the same, so a dry run's `gh` never sees a write.
    const act = dry
      ? { update: (pr) => ((seen.update = pr), ""), repost: (pr) => ((seen.carry = pr), "") }
      : {
          update: (pr) => {
            const result = realRun(["gh", "pr", "update-branch", String(pr.number)]);
            return result.status === 0 ? "" : result.stderr.trim() || `exit ${result.status}`;
          },
          repost: (pr, from) => postCleared(realRun, pr.head, `Carried from ${short(from)}: its own diff is unchanged`),
        };
    const failureHook = dry ? (_command, _input, hookEnv) => (hooks.push(`#${hookEnv.CONVEYOR_PR} at ${short(hookEnv.CONVEYOR_HEAD)}`), "") : hook;
    const report = () => dryReport(seen, { out, alarms, hooks, queued: state.outbox.length });
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
      } else if (!enabled.on) return stop();
      else if (state.stopped) {
        logLine(`conveyor: ${ENABLED_VARIABLE} is "${ENABLED_VALUE}" again; acting`);
        delete state.stopped;
      }
      if (!dry) flush();
      const code = await pass({ cwd, run, clock, env, hook: failureHook, dir, now, state, corrupt, tell, alarm, save, land, act, seen, dry });
      return dry ? report() : code;
    } catch (error) {
      if (dry) {
        seen.unread.push(`the pass failed: ${error.message}`);
        return report();
      }
      alarm(`crash:${hourOf(now)}`, `tick failed: ${error.message}`);
      return REPORTED;
    } finally {
      save(clock());
    }
  };

  const status = ({ cwd, run, now, out, err, dir }) => {
    out(switchLine(readSwitch(run)));
    const until = activeUntil(dir, now);
    const { state } = readState(dir);
    out(until ? `commando on until ${until.toISOString()}, in this clone` : "commando off in this clone (the switch is per clone; the timer reads its own)");
    out(state.lastTickAt ? `last tick ${state.lastTickAt}` : "no tick yet in this clone: is the timer installed, and is this its clone?");
    out(`clone: ${cloneProblem(cwd, run) || "on dev's tip"}`);
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
  const postCleared = (run, head, description) => {
    const post = run(["gh", "api", "--method", "POST", `repos/{owner}/{repo}/statuses/${head}`, "-f", "state=success", "-f", `context=${CLEARED_CONTEXT}`, "-f", `description=${description}`]);
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
    if (!pr.headRefOid?.startsWith(head)) {
      err(`conveyor: #${number}'s head is ${short(pr.headRefOid)}, not ${head}; review the new head, then clear it.`);
      return 1;
    }
    const problem = postCleared(run, pr.headRefOid, "Reviews passed at this head");
    if (problem) {
      err(`conveyor: can't post the status on #${number}: ${problem}`);
      return 1;
    }
    out(`#${number} cleared at ${short(pr.headRefOid)}; a later push voids it`);
    return 0;
  };

  const USAGE = "usage: conveyor.mjs tick [--dry-run] | status | report [--days N] | clear <pr> <head sha>";

  // Returns the exit code: 0 done, 1 gh failed or refused, 2 usage, 3 a tick failed and alarmed.
  const main = async (argv, { cwd = process.cwd(), run = defaultRun, clock = () => new Date(), out = console.log, err = console.error, env = process.env, hook = defaultHook, wrangle = wrangleMerge, beatMs = LOCK_BEAT_MS } = {}) => {
    const [command, ...rest] = argv;
    if (!["tick", "status", "report", "clear"].includes(command)) {
      err(USAGE);
      return 2;
    }
    if (command === "clear") {
      const [number, head] = rest;
      // Seven hex characters at least: a shorter prefix could match a head nobody reviewed.
      if (rest.length !== 2 || !/^[1-9]\d*$/.test(number) || !/^[0-9a-f]{7,40}$/.test(head)) {
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
    const lock = join(dir, LOCK_NAME);
    if (!takeLock(lock, clock())) {
      out("conveyor: another tick is running");
      return 0;
    }
    // Unref'd: a beat must never keep a finished tick's process alive.
    const beat = setInterval(() => writeAtomic(lock, lockText(clock())), beatMs);
    beat.unref();
    try {
      return await tick({ cwd, run, clock, out, err, env, hook, wrangle, dir });
    } finally {
      clearInterval(beat);
      rmSync(lock, { force: true });
    }
  };


  return { CLEARED_CONTEXT, ENABLED_VARIABLE, ENABLED_VALUE, COMMANDO_WARN_HOURS, MERGE_WAIT_MINUTES, DEV_SETTLE_MINUTES, DEV_STUCK_MINUTES, MERGE_RETRY_MINUTES, UPDATE_FLIGHT_MINUTES, LOCK_HUNG_MINUTES, REPORT_DAYS, OUTBOX_MAX, RUN_TIMEOUT_MS, STATE_NAME, LOG_NAME, LOCK_NAME, defaultRun, readsOnly, classify, readSwitch, devState, staleness, percentile, reportLine, readOnlyRun, main };
};
