// Verify lock recovery after a separate worker process is killed.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { takeLock } from "../src/state.mjs";

test("a live process excludes another tick and a killed owner can be reclaimed", { timeout: 5000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "conveyor-lock-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "worker.lock");
  const script = `
    import { takeLock } from ${JSON.stringify(new URL("../src/state.mjs", import.meta.url).href)};
    const release = takeLock(process.argv[1]);
    if (!release) process.exit(1);
    console.log("locked");
    setInterval(() => {}, 1000);
  `;
  const worker = spawn(process.execPath, ["--input-type=module", "-e", script, path], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => worker.kill("SIGKILL"));
  const stopped = once(worker, "exit");
  const ready = await Promise.race([once(worker.stdout, "data"), stopped]);
  assert.equal(String(ready[0]).trim(), "locked");
  assert.equal(takeLock(path), null);
  worker.kill("SIGKILL");
  assert.deepEqual(await stopped, [null, "SIGKILL"]);
  const release = takeLock(path);
  assert.equal(typeof release, "function");
  release();
});
