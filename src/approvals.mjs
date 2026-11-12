// Approval records, held-file reads and content fingerprints.
// Used by: the conveyor config and the package tests.
// Exports: createApprovals.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { isSha, parseJson } from "./github.mjs";
// The common git dir, so a worktree and its primary clone share one log.
const gitDir = (run, cwd) => {
  const result = run(["git", "-C", cwd, "rev-parse", "--git-common-dir"]);
  if (result.status !== 0) throw new Error("not inside a git repository");
  const dir = result.stdout.trim();
  return isAbsolute(dir) ? dir : join(cwd, dir);
};

// The commit a files-API entry's `contents_url` was made for (its `?ref=`): undefined when the entry
// has no such URL, "" when it has one that names no commit. Neither equals a head.
const listedAt = (url) => (typeof url === "string" && url !== "" ? (/[?&]ref=([0-9a-f]{40})(?:&|$)/.exec(url)?.[1] ?? "") : undefined);

// Each path's git mode at `head`, which the files API leaves out. Null when GitHub won't give the
// whole tree (a truncated one could miss a path): no mode, no digest.
const treeModes = (head, run) => {
  const result = run(["gh", "api", `repos/{owner}/{repo}/git/trees/${head}?recursive=1`, "--jq", "[.truncated, [.tree[] | [.path, .mode]]] | @json"]);
  if (result.status !== 0) return null;
  try {
    const [truncated, entries] = JSON.parse(result.stdout);
    return truncated ? null : new Map(entries);
  } catch {
    return null;
  }
};

// Every path a file list touches, a rename's old path too: moving a held file away changes that file.
const filePaths = (files) => files.flatMap((file) => (file.previous ? [file.path, file.previous] : [file.path]));

// The same fingerprint over any chosen files (a review gate's use it too). Null for none, or for one it can't vouch for.
const changeDigest = (files) => {
  if (files.length === 0 || files.some((file) => !file.sha || (file.status !== "removed" && !file.mode))) return null;
  const lines = files.map((file) => JSON.stringify([file.path, file.previous, file.status, file.sha, file.mode]));
  return createHash("sha256").update(lines.toSorted((x, y) => x.localeCompare(y)).join("\n")).digest("hex");
};

const headOf = (pr, run, includeFiles = false) => {
  const fields = includeFiles ? "headRefOid,baseRefOid,baseRefName,changedFiles" : "headRefOid";
  const view = run(["gh", "pr", "view", String(pr), "--json", fields]);
  if (view.status !== 0) return { error: `can't read #${pr}: ${view.stderr.trim()}` };
  try {
    const { headRefOid: head, baseRefOid: base, baseRefName: baseName, changedFiles } = JSON.parse(view.stdout);
    if (includeFiles) {
      return isSha(head) && isSha(base) && typeof baseName === "string" && baseName && Number.isSafeInteger(changedFiles) && changedFiles > 0
        ? { head, base, baseName, changedFiles }
        : { error: `can't verify #${pr}'s head, base and changed-file count` };
    }
    return head ? { head } : { error: `can't read #${pr}'s head commit` };
  } catch {
    return { error: `can't parse #${pr}` };
  }
};

// A PR's changed files from GitHub's files API: each one's path, status, blob id, a rename's old
// path, and the commit its contents_url names (`ref`). Null when GitHub won't give the list, or a line
// of it isn't a file entry: no list, no digest.
const prFiles = (pr, run) => {
  const result = run(["gh", "api", "--paginate", `repos/{owner}/{repo}/pulls/${pr}/files`, "--jq", '.[] | [.filename, .status, .sha, (.previous_filename // ""), (.contents_url // "")] | @json']);
  if (result.status !== 0) return null;
  try {
    return result.stdout.split("\n").filter(Boolean).map((line) => {
      const [path, status, sha, previous, url] = JSON.parse(line);
      if (typeof path !== "string") throw new Error("not a file entry");
      return { path, status, sha, previous, ref: listedAt(url) };
    });
  } catch {
    return null;
  }
};

// GitHub puts up to 300 changed files on the first compare page. Comparing immutable SHAs
// pins the diff even if the PR is retargeted and then restored during the request.
const MAX_COMPARE_FILES = 300;
const pinnedFiles = ({ base, head, changedFiles }, run) => {
  const response = run(["gh", "api", `repos/{owner}/{repo}/compare/${base}...${head}?per_page=1&page=1`, "--jq",
    "{base: .base_commit.sha, files: [.files[] | {filename, status, sha, previous_filename, contents_url}]}"]);
  const result = response.status === 0 ? parseJson(response.stdout) : null;
  if (result?.base !== base || !Array.isArray(result.files) || result.files.length !== changedFiles) return null;
  const files = [];
  for (const row of result.files) {
    if (typeof row?.filename !== "string" || !row.filename || !isSha(row.sha) ||
      !["added", "removed", "modified", "renamed", "copied", "changed", "unchanged"].includes(row.status) ||
      (row.status === "renamed" && (typeof row.previous_filename !== "string" || !row.previous_filename))) return null;
    files.push({ path: row.filename, status: row.status, sha: row.sha, previous: row.previous_filename ?? "", ref: listedAt(row.contents_url) });
  }
  return new Set(files.map((file) => file.path)).size === files.length ? files : null;
};

export const createApprovals = ({ HOLD_PATTERNS, MAX_PR_FILES, heldBy, pathsHeld, approvalsLog = "conveyor-approvals.log", boundedReads = false }) => {
  // Knobs: how long a yes lasts, and the log's name in the common git dir.
  const APPROVAL_HOURS = 24;
  const APPROVALS_LOG = approvalsLog;
  // The configured classes of held paths.
  const HOLD_CLASSES = [...new Set(HOLD_PATTERNS.map(([, why]) => why))];

  const validScope = (scope) => scope === "merge" || (scope?.startsWith("hold:") && HOLD_CLASSES.includes(scope.slice(5)));



  // The records still in force: written, not expired, and not more than the cap ahead (a hand-edited
  // expiry reads as void). Unparseable lines are skipped.
  const activeApprovals = (dir, now) => {
    const path = join(dir, APPROVALS_LOG);
    if (!existsSync(path)) return [];
    const latest = now.getTime() + APPROVAL_HOURS * 3600 * 1000;
    return readFileSync(path, "utf8")
      .split("\n")
      .flatMap((line) => {
        try {
          const record = JSON.parse(line);
          const until = new Date(record.expires).getTime();
          return until > now.getTime() && until <= latest && validScope(record.scope) ? [record] : [];
        } catch {
          return [];
        }
      });
  };





  // A fingerprint of one held class's change: which of its files changed and their exact content, by
  // blob id. No diff text to parse, so another file can't forge a held file's entry. Any edit to a held
  // path changes it, a push elsewhere doesn't, and a base merge changes it only if it changes those
  // files. The tree mode counts too: dropping a hook's exec bit changes what runs. Null, which only a
  // matching head can satisfy, when it can't vouch for every held path.
  const heldDigest = (files, why) => (files.length >= MAX_PR_FILES ? null : changeDigest(files.filter((file) => pathsHeld(filePaths([file]), why).length > 0)));


  // Whether the user approved this scope for this PR: at exactly this head, or, for a held class, for
  // exactly this held change, so a push that leaves those paths alone keeps the yes.
  const approved = (dir, now, { pr, scope, head, digest }) =>
    activeApprovals(dir, now).some((r) => r.pr === Number(pr) && r.scope === scope && (r.head === head || (Boolean(digest) && r.digest === digest)));


  // A PR's head and its files at that head. The head is read on both sides of the list, and each file's
  // listed commit must be it, so a push between the two reads can't pair one head with another's files.
  // `allModes` reads each file's mode even with nothing held: a review gate's digest covers files the hold list doesn't.
  const readHeld = (pr, run, { allModes = false, base, baseName } = {}) => {
    const before = headOf(pr, run, boundedReads);
    if (before.error) return before;
    if (boundedReads && (before.base !== base || before.baseName !== baseName)) return { error: `#${pr}'s base changed before reading held paths` };
    if (boundedReads && before.changedFiles > MAX_COMPARE_FILES) return { error: `#${pr} exceeds the pinned comparison limit of ${MAX_COMPARE_FILES} files` };
    const files = boundedReads ? pinnedFiles(before, run) : prFiles(pr, run);
    if (files === null) return { error: `can't read #${pr}'s changed files` };
    // A PR changes at least one file; an empty list under a good status is a read that lost its entries, and no held path was ruled out by it.
    if (files.length === 0) return { error: `#${pr}'s changed files came back empty, so no held path was ruled out` };
    if (files.length >= MAX_PR_FILES) return { error: `#${pr} is at GitHub's limit of ${MAX_PR_FILES} listed files, so a held path could be past it` };
    const after = headOf(pr, run, boundedReads);
    if (after.error) return after;
    if (after.head !== before.head) return { error: `#${pr} moved while it was being read` };
    if (boundedReads && (after.base !== base || after.baseName !== baseName || after.changedFiles !== before.changedFiles || files.length !== before.changedFiles)) {
      return { error: `can't verify the complete changed-file list for #${pr}` };
    }
    // Each entry's contents_url carries the commit it was listed at, so a list that straddles a push (head A, a
    // push of B, the files read, then A back) isn't this head's list. A removed file's URL names the base commit
    // (the file isn't at the head), so a removed entry is not checked.
    // An entry with no contents_url (ref undefined) has nothing to check, which is not a pass: the live API gives every entry one.
    if (files.some((file) => file.status !== "removed" && file.ref !== before.head)) return { error: `#${pr}'s changed files were listed at another commit than its head, so it moved while it was being read` };
    const paths = filePaths(files);
    if (!allModes && heldBy(paths).length === 0) return { head: before.head, files, paths };
    const modes = treeModes(before.head, run);
    return { head: before.head, files: files.map((file) => ({ ...file, mode: modes?.get(file.path) })), paths };
  };


  return { APPROVAL_HOURS, APPROVALS_LOG, HOLD_CLASSES, validScope, gitDir, activeApprovals, prFiles, filePaths, heldDigest, changeDigest, approved, headOf, readHeld };
};
