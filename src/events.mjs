// Append typed worker events for readers such as a live view or an agent tailing the worker.
// Used by: the worker's tick and the package tests.
// Exports: createEvents, readEvents, EVENTS_MAX_BYTES.
import { appendFileSync, readFileSync, renameSync, statSync } from "node:fs";

import { parseJson } from "./github.mjs";

// One previous file is kept, so the feed holds between one and two times this size.
export const EVENTS_MAX_BYTES = 1024 * 1024;

// The journal stays the record of intent and outcome. Events are a best-effort feed:
// a full disk or a bad path must never fail a tick, so every error is swallowed.
export const createEvents = (path, clock) => (type, fields = {}) => {
  try {
    try {
      if (statSync(path).size >= EVENTS_MAX_BYTES) renameSync(path, `${path}.1`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    appendFileSync(path, `${JSON.stringify({ schemaVersion: 1, at: clock().toISOString(), type, ...fields })}\n`, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
};

// Newest last. A torn or foreign line is skipped: a reader can race an append.
export const readEvents = (path, limit = 200) => {
  const lines = [];
  for (const file of [`${path}.1`, path]) {
    try {
      lines.push(...readFileSync(file, "utf8").split("\n"));
    } catch (error) {
      if (error.code !== "ENOENT") return null;
    }
  }
  return lines.map((line) => line && parseJson(line)).filter((event) => event?.schemaVersion === 1 && typeof event.type === "string").slice(-limit);
};
