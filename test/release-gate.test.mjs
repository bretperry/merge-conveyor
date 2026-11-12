// Exercises release gate exceptions against throwaway Git objects and fictional identities.
// Run: node --test test/release-gate.test.mjs. Uses Git and a stub for the independent secret scan.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";

import { parseTerms } from "../.release/lib/publish-terms.mjs";
import { KIT_FILES, LICENSE_PATH, renderKitFile } from "../.release/release-kit/kit.mjs";
import { createGateForTesting, formatReport, PATH_TERMS } from "../.release/release-kit/release-gate.mjs";

const LICENSOR = "Alex Quillfeather";
const YEAR = "2026";
const LOGIN = "fixture-owner";
const EMAIL = `1234+${LOGIN}@users.noreply.github.com`;
const TERMS = parseTerms(`quillfeather\n${LOGIN}`);
const fingerprint = (text) => createHash("sha256").update(text).digest("hex");

const fixture = (t, approvedEmail = EMAIL) => {
  const root = mkdtempSync(join(tmpdir(), "gate-identity-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  const bin = join(root, "bin");
  mkdirSync(repo);
  mkdirSync(bin);
  writeFileSync(join(bin, "gitleaks"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });

  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Example Author",
    GIT_AUTHOR_EMAIL: "author@example.test",
    GIT_COMMITTER_NAME: "Example Committer",
    GIT_COMMITTER_EMAIL: "committer@example.test",
  };
  const git = (args, options = {}) => execFileSync("git", args, { cwd: repo, encoding: "utf8", env, ...options }).trimEnd();
  git(["init", "-q"]);
  for (const file of Object.keys(KIT_FILES)) {
    const path = join(repo, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file === LICENSE_PATH ? renderKitFile(file, { licensor: LICENSOR, year: YEAR }) : "");
  }
  git(["add", "--all"]);
  git(["commit", "-qm", "Initial commit"]);

  const check = (where, { count = 1, commitSubjectException, step = "terms" } = {}) => {
    const gate = createGateForTesting({
      familyUrlFingerprints: new Set([fingerprint("https://example.test/project")]),
      identityEmailFingerprint: fingerprint(approvedEmail),
      commitSubjectException,
    });
    const saved = process.env.PATH;
    process.env.PATH = [bin, saved].join(delimiter);
    try {
      const result = gate({ dir: repo, terms: TERMS, licensor: LICENSOR, year: YEAR });
      const report = formatReport(result).join("\n");
      assert.deepEqual(result.steps.filter(({ ok }) => !ok).map(({ name }) => name), where ? [step] : [], report);
      if (where) {
        const lines = result.steps.find(({ name }) => name === step).lines;
        assert.ok(lines.filter((line) => where.test(line)).length >= count, report);
        return lines;
      }
    } finally {
      process.env.PATH = saved;
    }
  };
  const commit = (name, email, message = "Example commit") => git(["commit", "-q", "--allow-empty", "-m", message], {
    env: { ...env, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email },
  });
  return { repo, env, git, check, commit };
};

test("the release gate accepts the exact GitHub login in author and committer headers", (t) => {
  const { commit, check } = fixture(t);
  commit(LICENSOR, EMAIL);
  commit(LOGIN, EMAIL);
  check();
});

test("the release gate requires the exact login spelling and fingerprint-matched email", async (t) => {
  for (const [label, name, email] of [["different account ID", LOGIN, `5678+${LOGIN}@users.noreply.github.com`], ["different login case", LOGIN.toUpperCase(), EMAIL]]) {
    await t.test(label, (subtest) => {
      const { commit, check } = fixture(subtest);
      commit(name, email);
      check(/commit metadata/u, { count: 2 });
    });
  }
});

test("the release gate requires the ID-plus-login GitHub noreply email form for the login exception", (t) => {
  const legacyEmail = `${LOGIN}@users.noreply.github.com`;
  const { commit, check } = fixture(t, legacyEmail);
  commit(LICENSOR, legacyEmail);
  check();
  commit(LOGIN, legacyEmail);
  check(/commit metadata/u, { count: 2 });
});

test("the release gate scans an identity lookalike in a commit message", (t) => {
  const { commit, check } = fixture(t);
  commit(LICENSOR, EMAIL, `Example commit\n\nauthor ${LOGIN} <${EMAIL}> 0 +0000`);
  check(/commit message/u);
});

test("the release gate scans an identity lookalike in a blob", (t) => {
  const { repo, git, commit, check } = fixture(t);
  writeFileSync(join(repo, "notes.txt"), `author ${LOGIN} <${EMAIL}> 0 +0000\n`);
  git(["add", "notes.txt"]);
  commit(LICENSOR, EMAIL);
  check(/notes\.txt/u);
});

test("the release gate scans the login and email in a tagger header", (t) => {
  const { git, env, check } = fixture(t);
  git(["tag", "-a", "test-release", "-m", "Example tag"], {
    env: { ...env, GIT_COMMITTER_NAME: LOGIN, GIT_COMMITTER_EMAIL: EMAIL },
  });
  check(/annotated tag/u);
});

test("the release gate scans both occurrences of a duplicate identity header", async (t) => {
  for (const role of ["author", "committer"]) {
    await t.test(role, (subtest) => {
      const { git, commit, check } = fixture(subtest);
      commit(LOGIN, EMAIL);
      const raw = git(["cat-file", "commit", "HEAD"]);
      const line = raw.split("\n").find((header) => header.startsWith(`${role} `));
      const duplicate = raw.replace(`${line}\n`, `${line}\n${line}\n`);
      const oid = git(["hash-object", "--literally", "-t", "commit", "-w", "--stdin"], { input: `${duplicate}\n` });
      git(["update-ref", "HEAD", oid]);
      check(/commit metadata/u, { count: 2 });
    });
  }
});

test("the release gate requires both the exact commit and the exact subject fingerprint", (t) => {
  const { git, commit, check } = fixture(t);
  const subject = `Merge pull request from ${LOGIN}/example`;
  commit(LICENSOR, EMAIL, subject);
  const oid = git(["rev-parse", "HEAD"]);
  const commitSubjectException = { oid, fingerprint: fingerprint(subject) };
  check(undefined, { commitSubjectException });
  check(/commit message:1/u, { commitSubjectException: { oid, fingerprint: fingerprint(subject.toUpperCase()) } });

  commit(LICENSOR, EMAIL, subject);
  check(/commit message:1/u, { commitSubjectException });
});

test("the release gate still scans the same text later in the approved commit message", (t) => {
  const { git, commit, check } = fixture(t);
  const subject = `Merge pull request from ${LOGIN}/example`;
  commit(LICENSOR, EMAIL, `${subject}\n\n${subject}`);
  const commitSubjectException = { oid: git(["rev-parse", "HEAD"]), fingerprint: fingerprint(subject) };
  const lines = check(/commit message:3/u, { commitSubjectException });
  assert.deepEqual(lines, ["content commit message:3 matches term #2"]);
});

test("the release gate still checks the approved subject for home paths", (t) => {
  const { git, commit, check } = fixture(t);
  const subject = `${LOGIN} ${PATH_TERMS[0]}/example`;
  commit(LICENSOR, EMAIL, subject);
  const commitSubjectException = { oid: git(["rev-parse", "HEAD"]), fingerprint: fingerprint(subject) };
  check(/commit message:1/u, { commitSubjectException, step: "paths" });
});
