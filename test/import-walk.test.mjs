// The package source must import only Node builtins and its own files.
// Used by: node:test.
// Run: node --test test/import-walk.test.mjs.
// When: changing conveyor modules or their imports.
// Env: none.
// Writes: nothing.
// Exit: 0 imports stay inside the package source and approval storage has no private name, 1 a boundary escapes.
import assert from "node:assert/strict";
import { builtinModules } from "node:module";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = realpathSync(fileURLToPath(new URL("../src/", import.meta.url)));
const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

// The name is built from parts so this file carries no literal of it.
test("the approvals module carries no private project name", () => {
  assert.doesNotMatch(readFileSync(join(root, "approvals.mjs"), "utf8"), new RegExp(["whipple", "tree"].join(""), "iu"));
});

// Match the same import forms as the conveyor's existing hold-closure test.
// Computed imports are refused because their targets cannot be checked statically, except the one that
// loads the operator's own config module in embedded mode (src/embedded.mjs `load`).
const OPERATOR_CONFIG_IMPORT = { file: "embedded.mjs", argument: "url" };
const imports = (file) => {
  const source = readFileSync(file, "utf8").replace(/^[ \t]*\/\/.*$/gm, "");
  for (const call of source.matchAll(/\b(?:import|require)\s*\(([^)]*)\)/g)) {
    if (relative(root, file) === OPERATOR_CONFIG_IMPORT.file && call[1].trim() === OPERATOR_CONFIG_IMPORT.argument) continue;
    assert.match(call[1].trim(), /^(["'])[^"']+\1$/, `${file}: computed import`);
  }
  return [...source.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*|^import\s+)["']([^"']+)["']/gm)].map((match) => match[1]);
};

test("embedded mode has exactly one computed import, of the operator's config", () => {
  const source = readFileSync(join(root, OPERATOR_CONFIG_IMPORT.file), "utf8").replace(/^[ \t]*\/\/.*$/gm, "");
  assert.equal([...source.matchAll(/\bimport\s*\(\s*url\s*\)/g)].length, 1);
  assert.equal([...source.matchAll(/\b(?:import|require)\s*\(/g)].length, 1);
});

test("every conveyor runtime import stays in the package source or Node builtins", () => {
  const files = readdirSync(root, { recursive: true }).filter((name) => name.endsWith(".mjs") && !name.endsWith(".test.mjs"));
  assert.ok(files.length > 0);
  for (const name of files) {
    const file = join(root, name);
    for (const specifier of imports(file)) {
      if (builtins.has(specifier)) continue;
      assert.ok(specifier.startsWith("."), `${name}: external dependency ${specifier}`);
      const target = realpathSync(resolve(dirname(file), specifier));
      assert.ok(!relative(root, target).startsWith(".."), `${name}: escapes package source: ${specifier}`);
    }
  }
});
