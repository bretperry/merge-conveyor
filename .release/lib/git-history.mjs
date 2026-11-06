/*
  Git plumbing shared by the publish and package gates, without repository-specific configuration.
  Used by: scripts/lib/publish-tree.mjs and scripts/release-kit/release-gate.mjs; copied into seeded packages.
  Uses: git on PATH, node:child_process.
  Exports: git, gitOut, gitBytes, parseBatch, forEachHistoryBlob.
*/
import { spawnSync } from "node:child_process";

// Runs git in `cwd`; returns { status, stdout, stderr }. `env` adds to this call's environment only; `input` is stdin.
export const git = (cwd, args, { env = {}, input } = {}) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", input, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env }, maxBuffer: 1024 * 1024 * 1024 });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};

// Runs git and returns stdout; throws with git's own words on a non-zero exit.
export const gitOut = (cwd, args, options) => {
  const result = git(cwd, args, options);
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.trim() || `exit ${String(result.status)}`}`);
  return result.stdout;
};

// Runs git and returns stdout as raw bytes (a blob's content is not text); throws on a non-zero exit.
export const gitBytes = (cwd, args, input) => {
  const result = spawnSync("git", args, { cwd, input, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, maxBuffer: 1024 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${String(result.stderr).trim() || `exit ${String(result.status)}`}`);
  return result.stdout;
};

// Reads the output of `git cat-file --batch`: "<oid> <type> <size>\n<bytes>\n" per object. A missing object throws.
export const parseBatch = (buffer) => {
  const objects = [];
  let at = 0;
  while (at < buffer.length) {
    const end = buffer.indexOf(10, at);
    const [oid, type, size] = buffer.toString("utf8", at, end).split(" ");
    if (type === "missing") throw new Error(`git has no object ${oid}`);
    const length = Number(size);
    objects.push({ oid, type, bytes: buffer.subarray(end + 1, end + 1 + length) });
    at = end + 1 + length + 1;
  }
  return objects;
};

// Calls fn({ oid, path, bytes }) for every blob reachable from any ref (rev-list --all --objects, then cat-file), each once,
// `path` being the first path git names it by. This is how a binary file in old history gets read at all.
export const forEachHistoryBlob = (workDir, fn) => {
  const names = new Map();
  for (const line of gitOut(workDir, ["rev-list", "--all", "--objects"]).split("\n")) {
    if (line === "") continue;
    const space = line.indexOf(" ");
    const oid = space === -1 ? line : line.slice(0, space);
    if (!names.has(oid)) names.set(oid, space === -1 ? "" : line.slice(space + 1));
  }
  if (names.size === 0) return;
  const kinds = gitOut(workDir, ["cat-file", "--batch-check"], { input: `${[...names.keys()].join("\n")}\n` }).split("\n");
  const blobs = [...names.keys()].filter((_oid, at) => kinds[at]?.split(" ")[1] === "blob");
  if (blobs.length === 0) return;
  for (const { oid, bytes } of parseBatch(gitBytes(workDir, ["cat-file", "--batch"], `${blobs.join("\n")}\n`))) fn({ oid, path: names.get(oid) ?? "", bytes });
};

