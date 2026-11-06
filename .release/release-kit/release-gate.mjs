#!/usr/bin/env node
// The release gate: reads a seeded repo (its tree and its whole history) and goes red on a leaked term, a secret, a home path, or a runner label.
// Run: `node scripts/release-kit/release-gate.mjs --repo <dir> --licensor "<name>" [--year <yyyy>]`
// When: on every seeded repo before it is pushed (seed.mjs runs it itself), and again before each later release tag; CI and pre-push use the same gate; only a verified fork PR may omit private terms.
// Env: HARNESS_DENYLIST (the personal-term list, comma- or newline-separated; an unset or blank list is red, never a pass); RELEASE_LICENSOR and RELEASE_YEAR as fallbacks for the flags; PATH needs git and gitleaks; GITHUB_EVENT_NAME, GITHUB_EVENT_PATH, GITHUB_REF and GITHUB_REPOSITORY verify fork mode (without gitleaks the gate refuses to run at all).
// Writes: temp folders (removed after) for the tree copy; nothing in the repo.
// Exit: 0 every step green, 1 a step is red, 2 usage error.
// Flags: --fork-pr omits private terms only in a verified fork pull_request context.
//        --binary <path> (repeatable) names a file that may be a binary one; any other binary file is red (gitleaks skips binaries).
//        --allow <exact string> (repeatable) is ignored by the paths step only (step 4); a seeded repo's per-file allow entries live in the seed manifest.
// Used by: scripts/release-kit/seed.mjs, installed .release/check.mjs (CI, tags, pre-push); tested by scripts/release-kit/release-gate.test.mjs.
// Uses: scripts/lib/publish-gate.mjs (gitleaks, gitleaks suppression), scripts/lib/publish-terms.mjs (term search), scripts/lib/git-history.mjs (history reads), scripts/release-kit/kit.mjs; git, gitleaks.
// Options: allow ([string | { text, in? }]): an exact, case-sensitive string the paths step ignores, everywhere or only in the file `in`.
// Exports: gate (a repo → { ok, steps }), formatReport (steps → lines), toolProblem (why the gate cannot run, or null), PATH_TERMS (the path and runner tripwire), main (CLI, with optional binary/allow policy).
//
// Steps, in order; every step runs even when an earlier one is red, so one run lists everything:
//   1 shape    HEAD exists; no symlink or submodule; no gitleaks config or ignore file (they would steer the scan); no export-ignore or
//              export-subst attribute (git archive would drop or rewrite a file the scan reads); no refs/replace ref (it hides a commit);
//              no binary file, in the tree or in any commit, that was not named as binary (gitleaks skips binaries)
//   2 kit      LICENSE is the official template with only the year and licensor filled; no {{…}} is left in a kit file; package.json, if there, says "license": "FSL-1.1-MIT"
//   3 terms    HARNESS_DENYLIST over every file in every commit (all encodings), every path ever committed, every commit message and identity,
//              every ref name, every annotated tag (name, tagger, message). Exact canonical family URLs and the exact author/committer
//              identity are the only term exceptions. A report names a term by its number, never a path or ref name.
//   4 paths    generic home folders and runner labels (PATH_TERMS); private machine names belong only in HARNESS_DENYLIST.
//              The only step with an allow list: exact strings from the manifest's `allow`, blanked out before the search; never applied to step 3
//   5 secrets  gitleaks over the tree, over the tree's files under neutral names, and over the history; a gitleaks suppression marker in any commit is red
//
// The exceptions: the filled `Copyright <year> <licensor>` line of LICENSE; the licensor name in unique real author, committer,
// or tagger headers; the exact approved email for a matching author or committer; and exact canonical family URLs. Step 2 makes
// sure the copyright name appears only on the template line by requiring the rest of LICENSE to equal the template.
// Not enforced: a term that was encoded or split (publish-terms.mjs header), a secret gitleaks has no rule for, and the content of what the listed files do.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { findScanSuppressions, runGitleaks, runGitleaksRenamed } from "../lib/publish-gate.mjs";
import { describeHit, parseTerms, scanBytes, scanLabelled, scanLog, scanPath, TermsError } from "../lib/publish-terms.mjs";
import { forEachHistoryBlob, gitOut } from "../lib/git-history.mjs";
import { checkLicensor, checkYear, copyrightLine, KIT_FILES, LICENSE_PATH, renderKitFile } from "./kit.mjs";

// Generic path fragments are assembled so the gate can scan its own distributed source.
// Machine-specific and runner-specific names stay exclusively in the private term list.
const RUNNER_LABELS = [["self", "hosted"]];
const WORD_JOINS = [" ", "-", "_", ""];
export const PATH_TERMS = [
  ["/", "users"].join(""),
  ["\\", "users"].join(""),
  ["/", "home"].join(""),
  ["~", "/dev"].join(""),
  ["$home", "/dev"].join(""),
  ["${home}", "/dev"].join(""),
  ...RUNNER_LABELS.flatMap((words) => WORD_JOINS.map((glue) => words.join(glue))),
];

// How many lines a red step prints before it says "and N more".
const SHOWN = 25;

const SCAN_OVERRIDE = /(?:^|\/)\.?gitleaks[^/]*$/iu;

// Attributes that make `git archive` drop a file or rewrite its bytes, so the copy the secret scan reads is not the commit's.
const ARCHIVE_ATTRIBUTES = ["export-ignore", "export-subst"];

// The first bytes of file kinds gitleaks skips as binary (it sniffs content, not names): ZIP, ELF, PDF, gzip, bzip2, 7z, RAR, PNG, GIF, JPEG, Mach-O, PE, wasm.
const BINARY_SIGNATURES = [
  [0x50, 0x4b, 0x03, 0x04],
  [0x50, 0x4b, 0x05, 0x06],
  [0x50, 0x4b, 0x07, 0x08],
  [0x7f, 0x45, 0x4c, 0x46],
  [0x25, 0x50, 0x44, 0x46],
  [0x1f, 0x8b],
  [0x42, 0x5a, 0x68],
  [0x37, 0x7a, 0xbc, 0xaf],
  [0x52, 0x61, 0x72, 0x21],
  [0x89, 0x50, 0x4e, 0x47],
  [0x47, 0x49, 0x46, 0x38],
  [0xff, 0xd8, 0xff],
  [0xca, 0xfe, 0xba, 0xbe],
  [0xcf, 0xfa, 0xed, 0xfe],
  [0x4d, 0x5a],
  [0x00, 0x61, 0x73, 0x6d],
];

// Git's own test for binary (a NUL byte in the first 8000 bytes), or one of the signatures above.
const isBinary = (bytes) => bytes.subarray(0, 8000).includes(0) || BINARY_SIGNATURES.some((signature) => signature.every((byte, at) => bytes[at] === byte));

const step = (name, lines) => ({ name, ok: lines.length === 0, lines });

// Why the gate cannot run, or null. A gate without its scanner has scanned nothing, so it refuses to start: no step runs, no report passes.
export const toolProblem = () => {
  const probe = spawnSync("gitleaks", ["version"], { stdio: "ignore" });
  return probe.error === undefined ? null : "gitleaks is not installed or not on PATH: the gate refuses to run without it, so nothing was checked (brew install gitleaks)";
};

// HEAD's tree as [{ mode, path }].
const treeOf = (dir) =>
  gitOut(dir, ["ls-tree", "-r", "-z", "HEAD"])
    .split("\0")
    .filter((entry) => entry !== "")
    .map((entry) => ({ mode: entry.slice(0, entry.indexOf(" ")), path: entry.slice(entry.indexOf("\t") + 1) }));

// A blob of HEAD as bytes.
const blobAt = (dir, path) => {
  const result = spawnSync("git", ["show", `HEAD:${path}`], { cwd: dir, maxBuffer: 256 * 1024 * 1024 });
  return result.status === 0 ? result.stdout : null;
};

// Every path any commit ever touched, unquoted (`git log -p` prints a non-ASCII name octal-quoted, which no term matches), deleted files included.
const historyPaths = (dir) => [...new Set(gitOut(dir, ["-c", "core.quotePath=false", "log", "--all", "--name-only", "-z", "--no-renames", "-m", "--format="]).split("\0").filter((path) => path !== ""))];

// Every ref name and, for each annotated tag (nested ones too), the raw tag object: its name, tagger and message.
const refsAndTags = (dir) => {
  const refs = [];
  const tags = [];
  for (const line of gitOut(dir, ["for-each-ref", "--format=%(refname)%00%(objecttype)%00%(objectname)"]).split("\n")) {
    if (line === "") continue;
    const [ref, type, oid] = line.split("\0");
    refs.push(ref);
    let kind = type;
    let at = oid;
    for (let depth = 0; kind === "tag" && depth < 16; depth += 1) {
      const text = gitOut(dir, ["cat-file", "tag", at]);
      tags.push({ ref, text });
      kind = /^type (\S+)$/mu.exec(text)?.[1];
      at = /^object (\S+)$/mu.exec(text)?.[1];
    }
  }
  return { refs, tags };
};

// Every blob in every commit, once: { path, bytes }. Reads the history a single time for the steps that need the bytes.
const historyBlobs = (dir) => {
  const blobs = [];
  forEachHistoryBlob(dir, ({ path, bytes }) => blobs.push({ path, bytes }));
  return blobs;
};

// A path for a report line: itself, or `(term #N in a path)` when it holds a personal term, which a report never repeats.
const labelled = (path, personal) => {
  const hit = scanPath(path, personal)[0];
  return hit === undefined ? path : `(term #${hit.term + 1} in a path)`;
};

// Paths in `paths` carrying an export attribute, per `git check-attr` on the working tree (and .git/info/attributes) and on HEAD's own .gitattributes.
const archiveAttributeLines = (dir, paths, personal) => {
  if (paths.length === 0) return [];
  const input = paths.map((path) => `${path}\0`).join("");
  const found = new Set();
  for (const source of [[], ["--source=HEAD"]]) {
    let output;
    try {
      output = gitOut(dir, ["check-attr", ...source, "-z", "--stdin", ...ARCHIVE_ATTRIBUTES], { input });
    } catch (error) {
      // An old git has no --source; the plain pass above still ran. Anything else is a real failure.
      if (source.length === 0) throw error;
      continue;
    }
    const fields = output.split("\0");
    for (let at = 0; at + 2 < fields.length; at += 3) if (fields[at + 2] !== "unspecified" && fields[at + 2] !== "unset") found.add(`${labelled(fields[at], personal)} has the ${fields[at + 1]} attribute set: git archive would drop or rewrite it, so the secret scan would not read what is committed`);
  }
  return [...found];
};

// Step 1.
const shapeStep = (dir, tree, refs, blobs, binary, personal) => {
  const lines = [];
  for (const { mode, path } of tree) {
    const name = labelled(path, personal);
    if (mode === "120000") lines.push(`${name} is a symlink`);
    else if (mode === "160000") lines.push(`${name} is a submodule`);
    else if (SCAN_OVERRIDE.test(path)) lines.push(`${name} is a gitleaks config or ignore file, which could hide a finding`);
  }
  lines.push(...archiveAttributeLines(dir, tree.filter(({ mode }) => mode !== "120000" && mode !== "160000").map(({ path }) => path), personal));
  for (const ref of refs) if (ref.startsWith("refs/replace/")) lines.push(`${ref} replaces an object: a replaced commit is never scanned as it is stored`);
  const flagged = new Set();
  for (const { path, bytes } of blobs) {
    if (!isBinary(bytes) || binary.includes(path) || flagged.has(path)) continue;
    flagged.add(path);
    lines.push(`${labelled(path, personal)} is a binary file, which gitleaks skips: read it, then name it as binary (the manifest's "binary" list, or --binary) if it belongs`);
  }
  return step("shape", lines);
};

// Step 2.
const kitStep = (dir, tree, values) => {
  const lines = [];
  const license = blobAt(dir, LICENSE_PATH);
  if (license === null) lines.push(`${LICENSE_PATH} is missing`);
  else if (license.toString("utf8") !== renderKitFile(LICENSE_PATH, values)) lines.push(`${LICENSE_PATH} is not the FSL-1.1-MIT template with only the year and licensor filled (the terms are never edited)`);
  for (const path of Object.keys(KIT_FILES)) {
    const text = blobAt(dir, path)?.toString("utf8");
    if (text === undefined) lines.push(`${path} is missing`);
    // Embedded source and the pristine license template intentionally contain placeholder syntax.
    else if (!path.startsWith(".release/") && /\{\{[A-Z_]+\}\}|\$\{(?:year|licensor name)\}/u.test(text)) lines.push(`${path} still has an unfilled placeholder`);
  }
  if (tree.some(({ path }) => path === "package.json")) {
    let declared;
    try {
      declared = JSON.parse(blobAt(dir, "package.json").toString("utf8")).license;
    } catch {
      lines.push("package.json is not valid JSON");
    }
    if (declared !== "FSL-1.1-MIT") lines.push('package.json must say "license": "FSL-1.1-MIT"');
  }
  return step("kit", lines);
};

// Exact approved identities are kept outside the distributed harness. These one-way fingerprints
// let the gate compare complete tokens without carrying their private source strings.
const APPROVED_FAMILY_URL_FINGERPRINTS = new Set([
  "1302c18601c99e01562171afbcd14084bb86f011191747a90d2d9ecc7650b621",
  "499148d6fbb83d4940b4fd59ecd797734fd0fce3b3e93d9a152eba4c8ec02b24",
  "934087903c382627203880b277261fbaca72257970428a5bc9d01e42410b82bc",
  "2589b7ece48c2935cdcc61809270452830990bb212bd51e2ee8efdb65960acfb",
  "beec64797a22bc7526277c424f9b64cab463ede4900d81c747441891e7be7738",
  "2327d7b949aba0e9b0137cb1d16eeacda7fe8318d2a580d837d8f36d655161bf",
  "05bb3bfa6e84485ddfec76cb323053de1cc1cde64e516efd8657f7d60be08ca1",
  "4f65d74bfe164aee7a8040b1c036dfefbcf62a56d858ccd042e267b10a627dbb",
  "6f6f75de36c714e4e8b6239d89bcbd2b1c0a2237e8a6761a3f695ce14eada72c",
]);
const APPROVED_IDENTITY_EMAIL_FINGERPRINT = "edf66de584f8889227f518d4c4e2a20e679a40e77f401af4091956d7fc8dae53";
const fingerprint = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const URL_DELIMITERS = new Set([" ", "\t", "\r", "\n", "<", ">", "\"", "'", "`"]);

// Test-only policy injection uses the same exact-match engine with a fictional, fixed test policy.
// Production callers use `gate`, whose fingerprints are immutable module constants.
export const createGateForTesting = ({ familyUrlFingerprints, identityEmailFingerprint }) => {
  if (!(familyUrlFingerprints instanceof Set) || familyUrlFingerprints.size === 0 || [...familyUrlFingerprints].some((value) => !/^[a-f0-9]{64}$/u.test(value))) {
    throw new TypeError("family URL policy must be a non-empty set of SHA-256 fingerprints");
  }
  if (typeof identityEmailFingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(identityEmailFingerprint)) {
    throw new TypeError("identity email policy must be a SHA-256 fingerprint");
  }
  const fixedUrlFingerprints = new Set(familyUrlFingerprints);
  return (options) => gateWithPolicy(options, fixedUrlFingerprints, identityEmailFingerprint);
};

// Recognize one complete, lossless Git identity line before muting any part of it.
const identityFields = (line, role, licensor) => {
  const text = Buffer.isBuffer(line) ? line.toString("utf8") : line;
  if (Buffer.isBuffer(line) && !Buffer.from(text, "utf8").equals(line)) return null;
  const prefix = `${role} ${licensor} <`;
  if (!text.startsWith(prefix)) return null;
  const match = /^([^<>\s]+)> (-?\d+) ([+-]\d{4})$/u.exec(text.slice(prefix.length));
  return match === null ? null : { text, prefix, email: match[1] };
};

// Only a whole canonical URL token is exempt. Query values and URL-shaped suffixes remain intact.
const blankedFamilyUrls = (text, urlFingerprints, { patch = false } = {}) => {
  let out = text;
  let at = out.indexOf("https://");
  while (at !== -1) {
    const lineStart = out.lastIndexOf("\n", at - 1) + 1;
    const patchMarker = patch && (out[lineStart] === "+" || out[lineStart] === "-") && at === lineStart + 1;
    const before = at === 0 ? "" : out[at - 1];
    let end = at + "https://".length;
    while (end < out.length && !URL_DELIMITERS.has(out[end])) end += 1;
    const after = out[end] ?? "";
    const token = out.slice(at, end);
    if ((patchMarker || !before || URL_DELIMITERS.has(before)) && (!after || URL_DELIMITERS.has(after)) && urlFingerprints.has(fingerprint(token))) {
      out = `${out.slice(0, at)}${" ".repeat(token.length)}${out.slice(end)}`;
      at = out.indexOf("https://", at + token.length);
    } else at = out.indexOf("https://", at + "https://".length);
  }
  return out;
};

// Same exact URL exception on bytes; ASCII boundaries keep UTF-16 and other encodings red.
const blankedFamilyUrlBytes = (bytes, urlFingerprints) => {
  let out = bytes;
  let at = out.indexOf(Buffer.from("https://", "ascii"));
  while (at !== -1) {
    const before = at === 0 ? -1 : out[at - 1];
    let end = at + 8;
    while (end < out.length && !URL_DELIMITERS.has(String.fromCharCode(out[end]))) end += 1;
    const after = end === out.length ? -1 : out[end];
    const bytesAreAscii = out.subarray(at, end).every((byte) => byte < 0x80);
    const token = bytesAreAscii ? out.subarray(at, end).toString("ascii") : "";
    const boundary = (byte) => byte < 0 || URL_DELIMITERS.has(String.fromCharCode(byte));
    if (bytesAreAscii && boundary(before) && boundary(after) && urlFingerprints.has(fingerprint(token))) {
      if (out === bytes) out = Buffer.from(bytes);
      out.fill(0x20, at, end);
      at = out.indexOf(Buffer.from("https://", "ascii"), end);
    } else at = out.indexOf(Buffer.from("https://", "ascii"), at + 8);
  }
  return out;
};

// Read commit objects directly so exception handling never trusts text inside an unindented commit message.
const historyCommits = (dir, licensor, identityEmailFingerprint) => {
  const commits = [];
  for (const oid of gitOut(dir, ["rev-list", "--all"]).split("\n").filter(Boolean)) {
    const result = spawnSync("git", ["cat-file", "commit", oid], { cwd: dir, maxBuffer: 256 * 1024 * 1024 });
    if (result.status !== 0) throw new Error(`git cat-file commit failed: ${String(result.stderr).trim()}`);
    const raw = result.stdout;
    const split = raw.indexOf(Buffer.from("\n\n"));
    if (split < 0) throw new Error(`commit ${oid} has no header/message boundary`);
    const headers = [];
    for (let start = 0; start <= split; ) {
      const end = raw.indexOf(10, start);
      if (end < 0 || end > split) {
        headers.push(raw.subarray(start, split));
        break;
      }
      headers.push(raw.subarray(start, end));
      start = end + 1;
    }
    const message = raw.subarray(split + 2);
    const uniqueIdentityHeaders = (role) => headers.filter((line) => line.subarray(0, role.length + 1).equals(Buffer.from(`${role} `, "ascii"))).length === 1;
    const maskIdentity = (line, role) => {
      if (!uniqueIdentityHeaders(role)) return line;
      const fields = identityFields(line, role, licensor);
      if (fields === null) return line;
      let masked = Buffer.from(line);
      masked.fill(0x20, role.length + 1, role.length + 1 + Buffer.byteLength(licensor));
      if (fingerprint(fields.email) === identityEmailFingerprint) {
        const emailAt = Buffer.byteLength(fields.prefix);
        masked.fill(0x20, emailAt, emailAt + Buffer.byteLength(fields.email));
      }
      return masked;
    };
    const metadata = headers.map((line) => {
      if (line.subarray(0, 7).equals(Buffer.from("author ", "ascii"))) return maskIdentity(line, "author");
      if (line.subarray(0, 10).equals(Buffer.from("committer ", "ascii"))) return maskIdentity(line, "committer");
      return line;
    });
    commits.push({ metadata: Buffer.concat(metadata.flatMap((line, at) => (at === 0 ? [line] : [Buffer.from("\n"), line]))), message });
  }
  return commits;
};

// Remove the licensor name only from one actual tagger header; tag message lookalikes and tagger emails stay searchable.
const withoutLicensorTagger = (tag, licensor) => {
  const split = tag.indexOf("\n\n");
  if (split < 0) return tag;
  const lines = tag.slice(0, split).split("\n");
  const taggers = lines.filter((line) => line.startsWith("tagger "));
  const header = lines.map((line) => {
    if (taggers.length !== 1) return line;
    const fields = identityFields(line, "tagger", licensor);
    return fields === null ? line : `${line.slice(0, "tagger ".length)}${" ".repeat(licensor.length)}${line.slice("tagger ".length + licensor.length)}`;
  });
  return `${header.join("\n")}\n\n${tag.slice(split + 2)}`;
};

// `bytes` without its lines (split on LF) equal to `line`; every other byte is kept as it is, in whatever encoding it was.
const withoutLine = (bytes, line) => {
  const drop = Buffer.from(line, "utf8");
  const kept = [];
  for (let start = 0; start <= bytes.length; ) {
    const found = bytes.indexOf(10, start);
    const end = found === -1 ? bytes.length : found;
    const text = bytes.subarray(start, end);
    if (!text.equals(drop)) kept.push(text);
    start = end + 1;
  }
  return Buffer.concat(kept.flatMap((text, at) => (at === 0 ? [text] : [Buffer.from("\n"), text])));
};

// The allow list as [{ text, in? }], or throws a message. An entry is an exact, case-sensitive string (or { text, in }, for the file `in`).
// It may never hold a personal term. A bare tripwire is allowed (it is the owner's call, and `in` limits it to one file).
const allowEntries = (allow, personal) =>
  allow.map((entry) => {
    const text = typeof entry === "string" ? entry : entry?.text;
    const file = typeof entry === "string" ? undefined : entry?.in;
    if (typeof text !== "string" || text === "" || (file !== undefined && (typeof file !== "string" || file === ""))) throw new Error("an allow entry must be a non-empty string, or { text, in } with a file path");
    if (scanPath(text, personal).length > 0) throw new Error("an allow entry holds a personal term: allow never applies to the term list");
    return { text, in: file };
  });

// `text` with each of `strings` replaced by spaces of the same length (longest first).
const blanked = (text, strings) => strings.toSorted((a, b) => b.length - a.length).reduce((out, string) => out.split(string).join(" ".repeat(string.length)), text);

// The same on bytes (UTF-8 spellings only: the same string in UTF-16 stays a hit, which is the fail-closed side).
const blankedBytes = (bytes, strings) => {
  let out = bytes;
  for (const string of strings) {
    const needle = Buffer.from(string, "utf8");
    for (let at = out.indexOf(needle); at !== -1; at = out.indexOf(needle, at + needle.length)) {
      if (out === bytes) out = Buffer.from(bytes);
      out.fill(0x20, at, at + needle.length);
    }
  }
  return out;
};

// The allowed strings that apply in `file` (or everywhere, when file is undefined).
const allowedIn = (allow, file) => allow.filter((entry) => entry.in === undefined || entry.in === file).map((entry) => entry.text);

// `git log -p` text with the allowed strings blanked, tracking which file each line belongs to.
const logWithoutAllowed = (log, allow) => {
  let file = "";
  return log
    .split("\n")
    .map((text) => {
      const header = /^(?:\+\+\+|---) (?:[ab]\/)?(.*)$/u.exec(text);
      if (header !== null && header[1] !== "/dev/null") file = header[1];
      if (/^commit [0-9a-f]{40,64}$/u.test(text)) file = "";
      return blanked(text, allowedIn(allow, file));
    })
    .join("\n");
};

// Keep the licensor's historical exception limited to the exact copyright line in LICENSE diffs.
const withoutCopyrightPatch = (log, { licensor, year }) => {
  const line = copyrightLine(year, licensor);
  let file = "";
  return log.split("\n").flatMap((text) => {
    if (text.startsWith("diff --git ")) file = "";
    const header = /^(?:\+\+\+|---) (?:[ab]\/)?(.*)$/u.exec(text);
    if (header !== null && header[1] !== "/dev/null") file = header[1];
    if (file === LICENSE_PATH && /^[ +-]+/u.test(text) && text.replace(/^[ +-]+/u, "") === line) return [];
    return [text];
  }).join("\n");
};

// One search of the repo for `terms`: contents of every blob in every commit, every path ever committed, the history text, ref names, tags. Returns hit objects.
const scanRepo = (dir, tree, terms, values, facts, urlFingerprints, allow = []) => {
  const hits = [];
  const copyright = copyrightLine(values.year, values.licensor);
  for (const { path, bytes } of facts.blobs) {
    // The one line of LICENSE the name may stand on is dropped from the raw bytes; every other byte of it is searched, in its own encoding.
    const body = path === LICENSE_PATH ? withoutLine(bytes, copyright) : bytes;
    const exceptions = allow.length === 0 ? blankedFamilyUrlBytes(body, urlFingerprints) : blankedBytes(blankedFamilyUrlBytes(body, urlFingerprints), allowedIn(allow, path));
    hits.push(...scanBytes(path, exceptions, terms));
  }
  for (const path of new Set([...tree.map((entry) => entry.path), ...facts.paths])) hits.push(...scanPath(blanked(path, allowedIn(allow, undefined)), terms).map((hit) => ({ ...hit, path })));
  for (const commit of facts.commits) {
    hits.push(...scanBytes("commit metadata", commit.metadata, terms));
    hits.push(...scanBytes("commit message", blankedFamilyUrlBytes(commit.message, urlFingerprints), terms));
  }
  const log = blankedFamilyUrls(withoutCopyrightPatch(facts.log, values), urlFingerprints, { patch: true });
  hits.push(...scanLog(allow.length === 0 ? log : logWithoutAllowed(log, allow), terms));
  for (const ref of facts.refs) hits.push(...scanLabelled("ref", ref, blanked(ref, allowedIn(allow, undefined)), terms).map((hit) => ({ ...hit, path: ref })));
  for (const { ref, text } of facts.tags) {
    const tag = blankedFamilyUrls(blanked(withoutLicensorTagger(text, values.licensor), allowedIn(allow, undefined)), urlFingerprints);
    hits.push(...scanLabelled("tag", ref, tag, terms));
  }
  return hits;
};

// Hits as report lines, capped.
const capped = (lines) => (lines.length > SHOWN ? [...lines.slice(0, SHOWN), `and ${lines.length - SHOWN} more`] : lines);

// A path for a report: itself, unless it holds a personal term, which a report must never repeat.
const shown = (path, personal) => (scanPath(path, personal).length > 0 ? "(a path that holds a term)" : path);

// Steps 3 and 4: the same search, two lists.
const termStep = (dir, tree, terms, values, facts, urlFingerprints) => {
  const describe = (hit) => {
    const number = `term #${hit.term + 1}`;
    if (hit.where === "path") return `${number} in a path`;
    if (hit.where === "ref") return `${number} in a ref name`;
    if (hit.where === "tag") return `${number} in an annotated tag (its name, tagger or message)`;
    return describeHit({ ...hit, path: shown(hit.path, terms) });
  };
  return step("terms", capped([...new Set(scanRepo(dir, tree, terms, values, facts, urlFingerprints).map(describe))]));
};

const pathStep = (dir, tree, terms, values, facts, urlFingerprints, allow) => {
  const tripwires = parseTerms(PATH_TERMS.join("\n"));
  // Here the tripwire itself is not secret, so the report says which one went off; a path that holds a personal term is still not repeated.
  const describe = (hit) => `${hit.where} ${shown(hit.path, terms)}${hit.line > 0 ? `:${hit.line}` : ""} holds "${PATH_TERMS[hit.term]}" (a home folder or a runner label)`;
  return step("paths", capped([...new Set(scanRepo(dir, tree, tripwires, values, facts, urlFingerprints, allow).map(describe))]));
};

// Step 5.
const secretsStep = (dir, tree, blobs, personal, historyNames) => {
  const lines = [];
  // The scanners print the paths they read; any that holds a term is swapped for its label, longest first.
  const heavy = [...new Set([...tree.map(({ path }) => path), ...historyNames])].filter((path) => scanPath(path, personal).length > 0).toSorted((a, b) => b.length - a.length);
  const unnamed = (line) => heavy.reduce((text, path) => text.split(path).join(labelled(path, personal)), line);
  // A gitleaks suppression marker in any commit hides a line in that commit's history scan, even if a later commit removed it.
  const marked = new Set();
  // Assemble the diagnostic marker because the gate also scans its own distributed source.
  for (const { path, bytes } of blobs) if (/gitleaks:\s*allow/iu.test(bytes.toString("latin1"))) marked.add(`${labelled(path, personal)} has a ${["gitleaks", "allow"].join(":")} marker (in the tree or in an earlier commit), which would hide a finding from the scan`);
  lines.push(...marked);
  const copy = mkdtempSync(join(tmpdir(), "release-gate-"));
  try {
    const archive = spawnSync("sh", ["-c", 'git -C "$1" archive HEAD | tar -x -C "$2"', "sh", dir, copy], { encoding: "utf8" });
    if (archive.status !== 0) return step("secrets", [...lines, `could not copy HEAD's tree to scan it: ${archive.stderr.trim()}`]);
    const listed = tree.filter(({ mode }) => mode !== "120000" && mode !== "160000").map(({ path }) => path);
    // A listed file the archive left out (export-ignore) was not scanned: red, never a crash.
    const files = listed.filter((path) => existsSync(join(copy, path)));
    for (const path of listed) if (!files.includes(path)) lines.push(`${labelled(path, personal)} is in HEAD but not in its archive, so it was not scanned`);
    for (const result of [findScanSuppressions(copy, files), runGitleaks("dir", copy), runGitleaksRenamed(copy, files), runGitleaks("git", dir)]) lines.push(...result.lines.map(unnamed));
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
  return step("secrets", lines);
};

// Runs every step on the repo at `dir`. `options`: { dir, terms (folded, from parseTerms), licensor, year, binary (paths allowed to be binary), allow (exact strings the paths step ignores) }.
// Returns { ok, steps: [{ name, ok, lines }] }.
const gateWithPolicy = ({ dir, terms, licensor, year, binary = [], allow = [], skipTerms = false }, urlFingerprints, identityEmailFingerprint) => {
  if (!skipTerms && (!Array.isArray(terms) || terms.length === 0 || terms.some((term) => typeof term !== "string" || term.trim() === ""))) return { ok: false, steps: [step("terms", ["the gate never runs without its term list"])] };
  const missing = toolProblem();
  if (missing !== null) return { ok: false, steps: [step("tools", [missing])] };
  const problem = checkLicensor(licensor) ?? checkYear(year);
  if (problem !== null) return { ok: false, steps: [step("usage", [problem])] };
  let allowed;
  try {
    allowed = allowEntries(allow, terms);
  } catch (error) {
    return { ok: false, steps: [step("usage", [error.message])] };
  }
  const values = { licensor, year, package: "", repo: "" };
  // A `git replace` ref would show git a different commit than the one stored; every read below sees the stored objects.
  const savedReplace = process.env.GIT_NO_REPLACE_OBJECTS;
  process.env.GIT_NO_REPLACE_OBJECTS = "1";
  try {
    let tree;
    try {
      tree = treeOf(dir);
    } catch (error) {
      return { ok: false, steps: [step("shape", [`cannot read ${dir} as a git repo with a commit: ${error.message}`])] };
    }
    const { refs, tags } = refsAndTags(dir);
    const facts = {
      blobs: historyBlobs(dir),
      paths: historyPaths(dir),
      commits: historyCommits(dir, licensor, identityEmailFingerprint),
      log: gitOut(dir, ["log", "--all", "-p", "-m", "--no-renames", "--no-ext-diff", "--no-textconv", "--format="]),
      refs: refs.filter((ref) => !ref.startsWith("refs/publish/")),
      tags,
    };
    const steps = [shapeStep(dir, tree, refs, facts.blobs, binary, terms), kitStep(dir, tree, values), (skipTerms ? { name: "terms", ok: true, lines: ["SKIPPED private terms: fork PR has no denylist secret"] } : termStep(dir, tree, terms, values, facts, urlFingerprints)), pathStep(dir, tree, terms, values, facts, urlFingerprints, allowed), secretsStep(dir, tree, facts.blobs, terms, facts.paths)];
    return { ok: steps.every(({ ok }) => ok), steps };
  } finally {
    if (savedReplace === undefined) delete process.env.GIT_NO_REPLACE_OBJECTS;
    else process.env.GIT_NO_REPLACE_OBJECTS = savedReplace;
  }
};

// Production entry point: only the fixed fingerprints above can affect CLI and normal callers.
export const gate = (options) => gateWithPolicy({ ...options, skipTerms: false }, APPROVED_FAMILY_URL_FINGERPRINTS, APPROVED_IDENTITY_EMAIL_FINGERPRINT);

// The report as lines: one per step, then the red steps' findings.
export const formatReport = ({ steps }) => steps.flatMap(({ name, ok, lines }) => [`${ok ? "✓" : "✗"} ${name}`, ...lines.map((line) => `    ${line}`)]);

// ---- the command line ----

const USAGE = 'usage: node scripts/release-kit/release-gate.mjs --repo <dir> --licensor "<name>" [--year <yyyy>] [--binary <path>]... [--allow <exact string>]... [--fork-pr]';

export const main = (argv, env = process.env, write = (line) => console.log(line), options = {}) => {
  const skipTerms = argv.includes("--fork-pr");
  if (skipTerms) {
    // A main/tag run cannot opt out merely by setting a flag or leaving its secret unset.
    let event;
    try { event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8")); } catch { /* Invalid context refuses the exemption. */ }
    const head = event?.pull_request?.head?.repo?.full_name;
    if (env.GITHUB_EVENT_NAME !== "pull_request" || !env.GITHUB_REF?.startsWith("refs/pull/") || typeof head !== "string" || head === "" || event.pull_request.base?.repo?.full_name !== env.GITHUB_REPOSITORY || head === env.GITHUB_REPOSITORY) {
      write("✗ --fork-pr requires a fork pull_request event; the gate refuses to skip private terms");
      return 1;
    }
    argv = argv.filter((arg) => arg !== "--fork-pr");
  }
  const flags = new Map();
  const binary = [];
  const allow = [];
  for (let at = 0; at < argv.length; at += 2) {
    if (!["--repo", "--licensor", "--year", "--binary", "--allow"].includes(argv[at]) || at + 1 >= argv.length) {
      write(`${USAGE}\n(unknown or incomplete argument: ${argv[at]})`);
      return 2;
    }
    if (argv[at] === "--binary") binary.push(argv[at + 1]);
    else if (argv[at] === "--allow") allow.push(argv[at + 1]);
    else flags.set(argv[at].slice(2), argv[at + 1]);
  }
  const repo = flags.get("repo");
  const licensor = flags.get("licensor") ?? env.RELEASE_LICENSOR;
  const year = flags.get("year") ?? env.RELEASE_YEAR ?? String(new Date().getFullYear());
  if (repo === undefined || licensor === undefined) {
    write(`${USAGE}\n(missing: ${[repo === undefined ? "--repo" : "", licensor === undefined ? "--licensor" : ""].filter(Boolean).join(", ")})`);
    return 2;
  }
  let terms;
  try {
    terms = skipTerms ? [] : parseTerms(env.HARNESS_DENYLIST);
  } catch (error) {
    if (!(error instanceof TermsError)) throw error;
    write(`✗ ${error.message}: the gate never runs without its term list`);
    return 1;
  }
  const missing = toolProblem();
  if (missing !== null) {
    write(`✗ ${missing}`);
    return 1;
  }
  const result = gateWithPolicy({ dir: resolve(repo), terms, licensor, year, binary: [...binary, ...(options.binary ?? [])], allow: [...allow, ...(options.allow ?? [])], skipTerms }, APPROVED_FAMILY_URL_FINGERPRINTS, APPROVED_IDENTITY_EMAIL_FINGERPRINT);
  for (const line of formatReport(result)) write(line);
  return result.ok ? 0 : 1;
};

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) process.exit(main(process.argv.slice(2)));
