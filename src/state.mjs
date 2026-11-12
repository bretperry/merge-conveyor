// Persist the worker's journal and coordinate ticks in the common Git directory.
import { closeSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { isSha, parseJson } from "./github.mjs";

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isDate = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));
const isText = (value) => typeof value === "string";
const has = Object.hasOwn;
const optional = (object, field, validate) => !has(object, field) || validate(object[field]);
const mapOf = (validate) => (value) => isObject(value) && Object.values(value).every(validate);
const isFlight = (value) => isObject(value) && Number.isSafeInteger(value.number) && value.number > 0 && isSha(value.head) && isDate(value.at);
const isAction = (value) => isObject(value) && Number.isSafeInteger(value.number) && value.number > 0 &&
  isSha(value.headSha) && isDate(value.at) &&
  (value.kind === "merged" ? isSha(value.mergeSha) : value.kind === "updated" && isSha(value.newHeadSha));
const isOperation = (value) =>
  isFlight(value) && ["merge", "update"].includes(value.kind) && isText(value.base) && value.base.length > 0 && isSha(value.baseSha) && optional(value, "repo", (repo) => isText(repo) && repo.length > 0);

const validState = (value) =>
  isObject(value) &&
  optional(value, "schemaVersion", (version) => version === 1) &&
  ["alarmed", "hooked", "attempts"].every((field) => optional(value, field, mapOf(isDate))) &&
  ["lastTickAt", "lastSuccessfulTickAt", "lastMergeAt", "lastReportAt", "devBlockedSince"].every((field) => optional(value, field, isDate)) &&
  optional(value, "stopped", isText) &&
  optional(value, "voided", mapOf((entry) => isObject(entry) && Array.isArray(entry.classes) && entry.classes.every(isText) && isDate(entry.at))) &&
  optional(value, "outbox", (outbox) => Array.isArray(outbox) && outbox.every((entry) => isObject(entry) && isText(entry.key) && isText(entry.line))) &&
  optional(value, "outboxDropped", (count) => Number.isSafeInteger(count) && count >= 0) &&
  optional(value, "updating", (flight) => isFlight(flight) && isText(flight.digest) && optional(flight, "settled", (settled) => typeof settled === "boolean")) &&
  optional(value, "operation", isOperation) &&
  optional(value, "lastAction", isAction) &&
  !(has(value, "updating") && has(value, "operation"));

export const readState = (path) => {
  let saved;
  let legacy = false;
  try {
    saved = parseJson(readFileSync(path, "utf8"));
    legacy = isObject(saved) && !has(saved, "schemaVersion");
  } catch (error) {
    if (error.code !== "ENOENT") return { corrupt: true };
    saved = {};
  }
  if (!validState(saved)) return { corrupt: true };
  return { legacy, state: { alarmed: {}, hooked: {}, attempts: {}, outbox: [], outboxDropped: 0, voided: {}, ...saved, schemaVersion: 1 } };
};

export const writeState = (path, state, keepAfter) => {
  const fresh = (map) => Object.fromEntries(Object.entries(map).filter(([, at]) => Date.parse(at) >= keepAfter));
  const pruned = { ...state, alarmed: fresh(state.alarmed), hooked: fresh(state.hooked), attempts: fresh(state.attempts) };
  // The journal is flushed before the write is sent to GitHub. Readers see either whole version.
  writePrivateJson(path, pruned);
};

export const writePrivateJson = (path, value) => {
  const temp = mkdtempSync(join(dirname(path), `.${basename(path)}-`));
  const next = join(temp, "state");
  try {
    const fd = openSync(next, "wx", 0o600);
    try {
      writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(next, path);
    const parent = openSync(dirname(path), "r");
    try {
      fsyncSync(parent);
    } finally {
      closeSync(parent);
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
};

const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
};

export const takeLock = (path) => {
  // Each contender publishes its PID and unique ownership in one atomic mkdir, then checks for
  // competitors. At worst simultaneous starters both yield. A contender only reaps dead owners
  // by their unique name, so it cannot remove a new owner's lock.
  const parent = `${path}.d`;
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const own = mkdtempSync(join(parent, `${process.pid}-`));
  const release = () => rmSync(own, { recursive: true, force: true });
  let acquired = false;
  try {
    let legacy;
    try {
      legacy = readFileSync(path, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (legacy !== undefined) {
      const pid = parseJson(legacy)?.pid;
      if (!Number.isInteger(pid) || pid <= 0 || pidAlive(pid)) return null;
    }
    for (const entry of readdirSync(parent)) {
      const candidate = join(parent, entry);
      if (candidate === own) continue;
      const pid = Number(/^(\d+)-[\w-]+$/.exec(entry)?.[1]);
      if (!Number.isInteger(pid) || pid <= 0 || pidAlive(pid)) return null;
      rmSync(candidate, { recursive: true, force: true });
    }
    acquired = true;
    return release;
  } finally {
    if (!acquired) release();
  }
};
