#!/usr/bin/env node
// Runs the installed package gate with the committed license and saved binary/path exceptions.
// Run: `node .release/check.mjs [--fork-pr]`
// When: CI, tag publishing and pre-push; fork mode is accepted only for a verified fork PR event.
// Env: HARNESS_DENYLIST (required except fork PRs); GITHUB_EVENT_NAME, GITHUB_EVENT_PATH, GITHUB_REF, GITHUB_REPOSITORY verify fork mode; PATH needs git and gitleaks.
// Writes: temporary scan folders, removed by the gate; nothing in the repo.
// Exit: 0 gate green, 1 gate red or invalid policy, 2 usage error.
// Used by: package-gate.yml and .githooks/pre-push.
// Uses: release-kit/release-gate.mjs, release-kit/kit.mjs, git.
import { execFileSync } from "node:child_process";
import { main } from "./release-kit/release-gate.mjs";
import { gateOptions } from "./release-kit/kit.mjs";

// Read committed policy: an uncommitted edit must not approve a different commit.
const blob = (path) => execFileSync("git", ["show", `HEAD:${path}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

// Failures print a fixed stage name and the error class only: parser and git messages quote their input, which may hold a private term.
let stage = "reading LICENSE";
try {
  const license = /^Copyright (20\d\d) (.+)$/mu.exec(blob("LICENSE"));
  if (license === null) throw new Error("LICENSE has no copyright identity");
  stage = "reading .release/config.json";
  const raw = blob(".release/config.json");
  stage = "parsing .release/config.json";
  const { binary, allow } = gateOptions(JSON.parse(raw));
  stage = "running the gate";
  const args = ["--repo", ".", "--year", license[1], "--licensor", license[2]];
  process.exit(main([...args, ...process.argv.slice(2)], process.env, console.log, { binary, allow }));
} catch (error) {
  console.error(`Package gate refused: failed while ${stage} (${error instanceof Error ? error.name : "unknown error"}).`);
  process.exit(1);
}
