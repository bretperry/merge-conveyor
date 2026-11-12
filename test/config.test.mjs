// Conveyor config is rejected at construction, before adapters can perform I/O.
// Used by: node:test.
// Run: node --test test/config.test.mjs.
// When: changing the conveyor config contract.
// Env: none.
// Writes: nothing.
// Exit: 0 all assertions pass, 1 a config contract regressed.
import assert from "node:assert/strict";
import { test } from "node:test";

import { createConveyor } from "../src/index.mjs";

// A config shaped like a real one, with every adapter a stub.
const config = {
  base: "main",
  baseWorkflow: "ci.yml",
  release: { branch: "release" },
  switchVariable: "CONVEYOR_ENABLED",
  clearedContext: "conveyor/cleared",
  stateName: "conveyor",
  ageAlarms: { pokeHours: 2, tellHours: 4 },
  adapters: Object.fromEntries(["approved", "changeDigest", "gitDir", "heldDigest", "readHeld", "activeUntil", "commando", "heldBy", "isGateContext", "wrangleMerge", "approvedWork", "approvalClock"].map((name) => [name, () => null])),
};
config.adapters.DOCS_ONLY = /^docs\//;

test("rejects invalid config before returning a conveyor or calling adapters", () => {
  const calls = [];
  const valid = {
    ...config,
    adapters: Object.fromEntries(Object.entries(config.adapters).map(([name, value]) => [name,
      typeof value === "function" ? () => { calls.push(name); throw new Error("unexpected I/O"); } : value,
    ])),
  };
  const rejects = (value, field) => {
    assert.throws(() => createConveyor(value), (error) => {
      assert.ok(error instanceof TypeError);
      assert.ok(error.message.startsWith("Invalid conveyor config:"), error.message);
      assert.ok(error.message.includes(field), error.message);
      return true;
    });
    assert.deepEqual(calls, [], "validation must not invoke adapters");
  };

  for (const value of [undefined, null, [], "config"]) rejects(value, "config");
  rejects({ adapters: {}, ageAlarms: {}, release: {} }, "base");
  for (const field of ["base", "baseWorkflow", "switchVariable", "clearedContext", "stateName"]) {
    for (const value of [undefined, null, "", "  ", 42, {}]) rejects({ ...valid, [field]: value }, field);
  }
  for (const field of ["release", "ageAlarms", "adapters"]) {
    for (const value of [undefined, null, [], "invalid"]) rejects({ ...valid, [field]: value }, field);
    rejects({ ...valid, [field]: {} }, field);
  }
  for (const branch of [undefined, null, "", " ", 42]) rejects({ ...valid, release: { branch } }, "release.branch");
  rejects({ ...valid, release: { branch: valid.base } }, "release.branch");
  for (const field of ["pokeHours", "tellHours"]) {
    for (const value of [undefined, null, "2", NaN, Infinity, -Infinity, -1]) {
      rejects({ ...valid, ageAlarms: { ...valid.ageAlarms, [field]: value } }, `ageAlarms.${field}`);
    }
  }
  for (const tellHours of [0, 1, 2]) rejects({ ...valid, ageAlarms: { pokeHours: 2, tellHours } }, "ageAlarms.tellHours");
  for (const field of Object.keys(valid.adapters).filter((name) => name !== "DOCS_ONLY")) {
    for (const value of [undefined, null, {}, "function"]) rejects({ ...valid, adapters: { ...valid.adapters, [field]: value } }, `adapters.${field}`);
  }
  for (const value of [undefined, null, {}, ".*", () => true]) {
    rejects({ ...valid, adapters: { ...valid.adapters, DOCS_ONLY: value } }, "adapters.DOCS_ONLY");
  }
  assert.doesNotThrow(() => createConveyor({ ...valid, ageAlarms: { pokeHours: 0, tellHours: 0.5 } }));
  assert.deepEqual(calls, []);
});

test("state names follow the configured stateName", () => {
  const conveyor = createConveyor(config);
  assert.equal(conveyor.STATE_NAME, "conveyor.json");
  assert.equal(conveyor.LOG_NAME, "conveyor.log");
  assert.equal(conveyor.LOCK_NAME, "conveyor.lock");
  assert.equal(conveyor.CLEARED_CONTEXT, "conveyor/cleared");
  assert.equal(conveyor.ENABLED_VARIABLE, "CONVEYOR_ENABLED");
});
