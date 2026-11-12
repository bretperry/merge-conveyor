// Wait, pin and merge mechanics with project check policy injected.
// Used by: the conveyor CLI and the package tests.
// Exports: createMerge.
import { latestPerCheck } from "./merge-checks.mjs";
import { checkRows, ciVerdict } from "./ci.mjs";
import { hasStrictChecks, isSha, MERGE_METHODS, mergePull, parseJson, readMerge, readPull } from "./github.mjs";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
// One shell-free process call; `gh`'s exit code is only a hint (see fetch and merge).
const defaultRun = (argv, cwd) => {
  const result = spawnSync(argv[0], argv.slice(1), { encoding: "utf8", timeout: 120_000, killSignal: "SIGKILL", cwd });
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? (result.error?.message || "") };
};

const short = (sha) => (sha || "?").slice(0, 7);

// Heavy check names the given changed paths make mandatory. null (unknown) needs all of them.
const requiredHeavy = (paths, checks) => checks.filter((check) => paths === null || check.classify(paths)).map((check) => check.name);

// The PR's changed paths, or null if gh can't say (the caller then requires every heavy check).
const changedPaths = (number, run) => {
  const diff = run(["gh", "pr", "diff", String(number), "--name-only"]);
  if (diff.status !== 0) return null;
  const paths = diff.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  return paths.length > 0 ? paths : null;
};

// Compare the exact pair for a base advanced by this batch. The file list is on the first page
// and capped at 300, so a possibly incomplete list requires every heavy check.
const compareHead = (head, base, run) => {
  const result = run(["gh", "api", `repos/{owner}/{repo}/compare/${base}...${head}?per_page=1`, "--jq",
    "{status, behind_by, files: (.files // [] | map({filename, previous_filename}))}"]);
  const comparison = result.status === 0 ? parseJson(result.stdout) : null;
  if (comparison?.status !== "ahead" || comparison.behind_by !== 0) return null;
  const { files } = comparison;
  const isPath = (path) => typeof path === "string" && path.length > 0;
  const complete = Array.isArray(files) && files.length > 0 && files.length < 300 &&
    files.every((file) => isPath(file?.filename) && (file.previous_filename == null || isPath(file.previous_filename)));
  return { paths: complete ? files.flatMap(({ filename, previous_filename }) => previous_filename ? [filename, previous_filename] : [filename]) : null };
};

const scopeLabel = (heavy) => (heavy.length > 0 ? heavy.join(", ") : "none (cheap checks only)");

// Why waiting can't help (closed, merged, wrong base), or "" if it might.
const terminal = (snap) => {
  if (snap.error) return "";
  if (snap.state !== "OPEN") return `PR is ${snap.state}`;
  if (snap.base !== snap.wantBase) return `base is '${snap.base}', not '${snap.wantBase}'; refusing`;
  // A caller that vetted one exact head (commando's hold list) gets that head or nothing.
  if (snap.wantHead && snap.head !== snap.wantHead) return `head moved ${short(snap.wantHead)} -> ${short(snap.head)} since it was checked; refusing`;
  return "";
};

// Reasons this PR can't merge right now. Empty means ready on this poll.
const verdict = (snap, heavy) => {
  if (snap.error) return [snap.error];
  if (terminal(snap)) return [terminal(snap)];
  const reasons = [];
  if (snap.draft) reasons.push("draft");
  if (snap.mergeable === "CONFLICTING") reasons.push(`merge conflict with ${snap.wantBase}`);
  else if (snap.mergeable !== "MERGEABLE" || snap.mergeState !== "CLEAN") reasons.push("GitHub does not report this PR ready to merge");
  if (snap.checks.length === 0) reasons.push("no checks reported yet");
  const byName = new Map();
  for (const row of snap.checks) byName.set(row.name ?? "", [...(byName.get(row.name ?? "") ?? []), row.bucket ?? ""]);
  const pending = [...byName].filter(([, buckets]) => buckets.includes("pending")).map(([name]) => name).toSorted((a, b) => a.localeCompare(b));
  const bad = [...byName]
    .filter(([, buckets]) => buckets.some((bucket) => !["pass", "skipping", "pending"].includes(bucket)))
    .map(([name]) => name)
    .toSorted((a, b) => a.localeCompare(b));
  if (pending.length > 0) reasons.push(`pending: ${pending.join(", ")}`);
  if (bad.length > 0) reasons.push(`failing: ${bad.join(", ")}`);
  for (const name of heavy) {
    const buckets = byName.get(name);
    if (!buckets) reasons.push(`${name} not reported (heavy)`);
    else if (!pending.includes(name) && !bad.includes(name) && !buckets.includes("pass")) reasons.push(`${name} ${buckets.join("/")} (heavy, needs pass)`);
  }
  return reasons;
};

export const createMerge = ({ loadHeavyChecks, isGateContext, base, releaseBranch, mergeMethod = "merge" }) => {
  const STABLE_POLLS = 3;
  const DEFAULT_WAIT_MINUTES = 55;
  const DEFAULT_POLL_SECONDS = 30;

  // The PR identity and rollup arrive in the same response, so a separate checks request cannot
  // accidentally supply evidence for a different head.
  const fetchPr = (number, run, wantBase, wantHead) => {
    const snap = { number, state: "?", draft: true, head: "", base: "", mergeable: "UNKNOWN", checks: [], error: "", wantBase, wantHead };
    const pr = readPull(run, number, ["baseRefOid", "isDraft", "mergeable", "mergeStateStatus", "statusCheckRollup"]);
    if (!pr || !isSha(pr.baseRefOid) || typeof pr.isDraft !== "boolean") return { ...snap, error: "can't verify the PR's state, head and base" };
    Object.assign(snap, { state: pr.state, draft: pr.isDraft, head: pr.headRefOid, base: pr.baseRefName, baseSha: pr.baseRefOid, mergeable: pr.mergeable, mergeState: pr.mergeStateStatus });
    if (terminal(snap)) return snap;
    const rows = checkRows(pr.statusCheckRollup);
    if (!rows) return { ...snap, error: "PR checks unavailable or incomplete" };
    snap.checks = rows
      .filter((row) => !(row.__typename === "StatusContext" && isGateContext(row.context)))
      .map((row) => {
        const outcome = ciVerdict([row]);
        const bucket = outcome === "green" ? (["SKIPPED", "NEUTRAL"].includes(row.conclusion) ? "skipping" : "pass") : outcome;
        return { ...row, bucket };
      });
    return snap;
  };

  // Polls a set of PRs until each has been ready for STABLE_POLLS polls, then merges them.
  class Batch {
    constructor(numbers, { checks, run, clock = () => performance.now() / 1000, sleep = (s) => new Promise((done) => setTimeout(done, s * 1000)), out = console.log, ship, wantBase, wantHead, method, beforeMerge = () => "" }) {
      Object.assign(this, { numbers, checks, run, clock, sleep, out, ship, wantBase, wantHead, method, beforeMerge });
      this.heavyCache = new Map();
    }

    // The ship asks for every heavy check. Otherwise cache by both refs, which determine the diff.
    heavyFor(snap) {
      if (this.ship) return this.checks.map((check) => check.name);
      const key = `${snap.number}@${snap.head}:${snap.baseSha}`;
      if (!this.heavyCache.has(key)) this.heavyCache.set(key, requiredHeavy(changedPaths(snap.number, this.run), this.checks));
      return this.heavyCache.get(key);
    }

    check(number) {
      const snap = fetchPr(number, this.run, this.wantBase, this.wantHead);
      const heavy = snap.error || terminal(snap) ? [] : this.heavyFor(snap);
      return { snap, heavy, reasons: verdict(snap, heavy) };
    }

    dryRun() {
      for (const n of this.numbers) {
        const { snap, heavy, reasons } = this.check(n);
        const head = `base=${snap.base || "?"} head=${short(snap.head)} heavy=${scopeLabel(heavy)}`;
        if (reasons.length > 0) this.out(`#${n} NOT READY (${head}): ${reasons.join("; ")}`);
        else this.out(`#${n} ready now (${head}); a real run still waits ${STABLE_POLLS} stable polls`);
      }
      this.out("dry run: nothing merged");
      return 0;
    }

    // Returns pinned head/base pairs and the last reasons for unqualified PRs.
    async wait(waitSeconds, pollSeconds, partial) {
      const deadline = this.clock() + waitSeconds;
      const pinned = new Map();
      const streak = new Map(this.numbers.map((n) => [n, 0]));
      const lastRefs = new Map();
      const reasons = new Map();
      const dead = new Set();
      const lastLine = new Map();
      for (;;) {
        for (const n of this.numbers) {
          if (pinned.has(n) || dead.has(n)) continue;
          const { snap, heavy, reasons: why } = this.check(n);
          if (terminal(snap)) dead.add(n);
          const refs = `${snap.head}:${snap.baseSha}`;
          let line;
          if (why.length > 0) {
            streak.set(n, 0);
            reasons.set(n, why);
            line = `#${n} waiting: ${why.join("; ")}`;
          } else {
            streak.set(n, lastRefs.get(n) === refs ? streak.get(n) + 1 : 1);
            reasons.set(n, [`ready ${streak.get(n)}/${STABLE_POLLS} polls, not yet stable`]);
            line = `#${n} ready ${streak.get(n)}/${STABLE_POLLS} head ${short(snap.head)} heavy ${scopeLabel(heavy)}`;
          }
          lastRefs.set(n, refs);
          if (line !== lastLine.get(n)) {
            this.out(line);
            lastLine.set(n, line);
          }
          if (streak.get(n) >= STABLE_POLLS) {
            pinned.set(n, { head: snap.head, baseSha: snap.baseSha });
            reasons.delete(n);
            this.out(`#${n} QUALIFIED head ${short(snap.head)}`);
          }
        }
        const remaining = this.numbers.filter((n) => !pinned.has(n));
        if (remaining.length === 0) break;
        // Closed / merged / wrong base won't fix itself: all-or-nothing stops now.
        if (dead.size > 0 && !partial) break;
        if (remaining.every((n) => dead.has(n))) break;
        if (this.clock() >= deadline) break;
        await this.sleep(pollSeconds);
      }
      const unqualified = new Map(this.numbers.filter((n) => !pinned.has(n)).map((n) => [n, reasons.get(n) ?? ["never checked"]]));
      return { pinned, unqualified };
    }

    // Merges each pinned PR in input order after a fresh check. Returns the merged numbers.
    merge(pinned) {
      const merged = [];
      let advance;
      for (const n of this.numbers) {
        if (!pinned.has(n)) continue;
        const { head, baseSha } = pinned.get(n);
        const stop = this.beforeMerge(n);
        if (stop) {
          this.out(`#${n} SKIPPED: ${stop}`);
          continue;
        }
        if (advance && baseSha !== advance.from) {
          this.out(`#${n} SKIPPED: qualified on a different base than this batch`);
          continue;
        }
        if (!hasStrictChecks(this.run, this.wantBase)) {
          this.out(`#${n} SKIPPED: can't verify strict required checks on ${this.wantBase}`);
          continue;
        }
        const expectedBase = advance?.to ?? baseSha;
        const comparison = advance && compareHead(head, expectedBase, this.run);
        if (advance && !comparison) {
          this.out(`#${n} SKIPPED: can't verify its head contains the batch's new base ${short(expectedBase)}`);
          continue;
        }
        const heavy = comparison ? requiredHeavy(comparison.paths, this.checks) : this.heavyFor({ number: n, head, baseSha });
        const snap = fetchPr(n, this.run, this.wantBase, this.wantHead);
        const why = verdict(snap, heavy);
        if (!snap.error && snap.head !== head) why.unshift(`head changed ${short(head)} -> ${short(snap.head)}`);
        if (!snap.error && snap.baseSha !== expectedBase) why.unshift(`base tip changed ${short(expectedBase)} -> ${short(snap.baseSha)}`);
        if (why.length > 0) {
          this.out(`#${n} SKIPPED: ${why.join("; ")}`);
          continue;
        }
        const write = mergePull(this.run, n, head, this.method);
        const outcome = readMerge(this.run, n);
        if (outcome?.state !== "MERGED" || outcome.headRefOid !== head || outcome.baseRefName !== this.wantBase) {
          this.out(`#${n} MERGE UNCONFIRMED (state=${outcome?.state ?? "?"}, exit ${write.status})`);
          break;
        }
        this.out(`#${n} MERGED ${short(outcome.mergeCommit.oid)}`);
        merged.push(n);
        advance = { from: baseSha, to: outcome.mergeCommit.oid };
      }
      return merged;
    }
  }

  const USAGE = "usage: wrangle-merge.mjs PR [PR ...] [--wait-minutes N] [--poll-seconds N] [--partial] [--dry-run] [--ship]";

  // Parsed options, or { error } for a usage mistake (exit 2).
  const parseCli = (argv) => {
    let parsed;
    try {
      parsed = parseArgs({
        args: argv,
        allowPositionals: true,
        options: {
          "wait-minutes": { type: "string", default: String(DEFAULT_WAIT_MINUTES) },
          "poll-seconds": { type: "string", default: String(DEFAULT_POLL_SECONDS) },
          partial: { type: "boolean", default: false },
          "dry-run": { type: "boolean", default: false },
          ship: { type: "boolean", default: false },
        },
      });
    } catch (error) {
      return { error: error.message };
    }
    const { values, positionals } = parsed;
    if (positionals.length === 0) return { error: "name at least one PR" };
    if (!positionals.every((p) => /^[1-9]\d*$/.test(p))) return { error: "PR numbers must be positive integers" };
    const waitMinutes = Number(values["wait-minutes"]);
    const pollSeconds = Number(values["poll-seconds"]);
    if (!Number.isFinite(waitMinutes) || !Number.isFinite(pollSeconds) || waitMinutes < 0 || pollSeconds < 0) return { error: "--wait-minutes and --poll-seconds take a number" };
    // Keep order, drop repeats: merging PR 165 twice is a failed merge, not a feature.
    const prs = [...new Set(positionals.map(Number))];
    // A ship is one PR by definition, and --partial means nothing with one. Refusing both keeps
    // --ship from ever reading as "merge whichever of these happens to be green".
    if (values.ship && prs.length !== 1) return { error: "--ship takes exactly one PR" };
    if (values.ship && values.partial) return { error: "--ship and --partial are contradictory" };
    return { prs, waitMinutes, pollSeconds, partial: values.partial, dryRun: values["dry-run"], ship: values.ship };
  };

  // The whole run; returns the exit code (0 all merged or dry run, 1 something didn't, 2 usage).
  // `wantHead` (programmatic only, one PR): merge only if the PR's head is still that commit.
  // `beforeMerge` (programmatic only): called before each merge preflight; a non-empty reason skips it.
  const main = async (argv, { root = process.cwd(), run = (argv) => defaultRun(argv, root), clock, sleep, out = console.log, err = console.error, wantHead = "", beforeMerge, base: featureBase = base, releaseBranch: shipBase = releaseBranch, mergeMethod: method = mergeMethod } = {}) => {
    const args = parseCli(argv);
    if (args.error) {
      err(`${USAGE}\nwrangle-merge: ${args.error}`);
      return 2;
    }
    const wantBase = args.ship ? shipBase : featureBase;
    if (typeof wantBase !== "string" || !wantBase || !MERGE_METHODS.includes(method)) {
      err("wrangle-merge: configure a target base and a supported merge method");
      return 2;
    }
    if (wantHead && (args.prs.length !== 1 || !isSha(wantHead))) {
      err("wrangle-merge: wantHead must be the full SHA for exactly one PR");
      return 2;
    }
    const checks = await loadHeavyChecks(root);
    const batch = new Batch(args.prs, { checks, run, clock, sleep, out, ship: args.ship, wantHead, wantBase, method, beforeMerge });
    if (args.dryRun) return batch.dryRun();
    if (args.ship) out(`SHIP: merging #${args.prs[0]} into ${wantBase} deploys production immediately`);
    out(`batch ${args.prs.map((n) => `#${n}`).join(" ")}: ${args.partial ? "partial" : "all-or-nothing"}, wait up to ${args.waitMinutes} min`);
    const { pinned, unqualified } = await batch.wait(args.waitMinutes * 60, args.pollSeconds, args.partial);
    for (const [n, why] of unqualified) out(`#${n} NOT QUALIFIED: ${why.join("; ")}`);
    if (unqualified.size > 0 && !args.partial) {
      out("all-or-nothing: merged none (rerun with --partial to merge the qualified ones)");
      return 1;
    }
    return batch.merge(pinned).length === args.prs.length ? 0 : 1;
  };


  return { STABLE_POLLS, requiredHeavy, latestPerCheck, verdict, parseCli, main };
};
