/*
  The release kit's shared parts: the template files, how they are filled, and the checks on the values that fill them.
  In the app: nothing at runtime; seed.mjs and release-gate.mjs import it. Copied into seeded packages for the ongoing gate.
  Used by: scripts/release-kit/seed.mjs, scripts/release-kit/release-gate.mjs; tested by scripts/release-kit/seed.test.mjs and release-gate.test.mjs.
  Uses: node builtins only.
  Exports: KIT_FILES (protected kit destinations), LICENSE_PATH, renderKitFile, copyrightLine, checkLicensor, checkYear, checkRepo, checkPackage, gateOptions (persisted binary/path exceptions).

  Every seeded repo carries the legal documents, CI and publishing workflows, a pre-push hook,
  and the gate with its dependencies. Gate source files are copied verbatim; only document and workflow
  templates are filled. The private term list is never a kit file.

  The licensor is the owner's real name, so it is the one personal string a seeded repo may carry, and only as the
  Copyright line of the LICENSE. The name is checked here (letters, spaces, . ' - only) so the value that is exempted
  from the term check can't carry an email, a path, or a token in with it.
*/

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TEMPLATES_DIR = join(dirname(fileURLToPath(import.meta.url)), "templates");

export const LICENSE_PATH = "LICENSE";

// Source dependencies retain their relative imports in the seeded tree.
const SOURCE_FILES = {
  ".release/release-kit/release-gate.mjs": "release-gate.mjs",
  ".release/release-kit/kit.mjs": "kit.mjs",
  ".release/release-kit/templates/LICENSE": "templates/LICENSE",
  ".release/lib/publish-gate.mjs": "../lib/publish-gate.mjs",
  ".release/lib/publish-terms.mjs": "../lib/publish-terms.mjs",
  ".release/lib/git-history.mjs": "../lib/git-history.mjs",
};

// Every protected kit destination, including generated policy and verbatim source.
export const KIT_FILES = {
  [LICENSE_PATH]: "LICENSE",
  "SECURITY.md": "SECURITY.md",
  "CONTRIBUTING.md": "CONTRIBUTING.md",
  ".github/workflows/publish.yml": "publish.yml",
  ".github/workflows/package-gate.yml": "package-gate.yml",
  ".githooks/pre-push": "pre-push",
  ".release/check.mjs": "check.mjs",
  ".release/config.json": null,
  ...SOURCE_FILES,
};

// Letters, combining marks, spaces and . ' ’ - ; 2 to 80 characters; starts and ends with a letter or a dot.
const LICENSOR = /^[\p{L}][\p{L}\p{M} .'’-]{0,78}[\p{L}.]$/u;
const YEAR = /^20\d\d$/u;
// An npm package name without a scope, and a GitHub owner/name.
const PACKAGE = /^[a-z0-9][a-z0-9._-]{0,213}$/u;
const REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/u;

// Each check returns null when fine, else a sentence saying what is wrong.
export const checkLicensor = (value) => (typeof value === "string" && LICENSOR.test(value) && value === value.trim() && !value.includes("  ") ? null : "the licensor must be a name: letters, spaces, and . ' - only (no digits, email, path or symbols)");
export const checkYear = (value) => (typeof value === "string" && YEAR.test(value) ? null : "the year must be four digits starting 20");
export const checkPackage = (value) => (typeof value === "string" && PACKAGE.test(value) ? null : "package must be an unscoped npm name: lower case letters, digits, . _ -");
export const checkRepo = (value) => (typeof value === "string" && REPO.test(value) ? null : "repo must be owner/name");

// The line the LICENSE's Notice section carries once filled: the one line the term check lets a name stand on.
export const copyrightLine = (year, licensor) => `Copyright ${year} ${licensor}`;

// `text` with each `{{KEY}}` replaced from `values`. Throws on a key with no value.
const fillTemplate = (text, values) => {
  return text.replaceAll(/\{\{([A-Z_]+)\}\}/gu, (_whole, key) => {
    if (!Object.hasOwn(values, key)) throw new Error(`template needs {{${key}}}, which was not given`);
    return values[key];
  });
};

// The text of one kit file as a seeded repo holds it. `values`: { package, repo, licensor, year, binary?, allow? }.
export const renderKitFile = (path, values, templatesDir = TEMPLATES_DIR) => {
  const name = KIT_FILES[path];
  if (name === undefined) throw new Error(`${path} is not a kit file`);
  if (path === ".release/config.json") return JSON.stringify({ binary: values.binary ?? [], allow: values.allow ?? [] }, null, 2) + "\n";
  if (Object.hasOwn(SOURCE_FILES, path)) return readFileSync(join(dirname(fileURLToPath(import.meta.url)), SOURCE_FILES[path]), "utf8");
  const raw = readFileSync(join(templatesDir, name), "utf8");
  if (path === LICENSE_PATH) {
    if (raw.split("${year}").length !== 2 || raw.split("${licensor name}").length !== 2) throw new Error("the LICENSE template must hold ${year} and ${licensor name} once each");
    return raw.replace("${year}", () => values.year).replace("${licensor name}", () => values.licensor);
  }
  return fillTemplate(raw, { PACKAGE: values.package, REPO: values.repo });
};

// Persist explicit path exceptions for later runs; their JSON spellings are allowed only in the policy file.
// The term step never reads these exceptions, so no private term is exempted.
export const gateOptions = ({ binary = [], allow = [] }) => ({
  binary,
  allow: [...allow, ...allow.map((entry) => ({ text: JSON.stringify(typeof entry === "string" ? entry : entry.text).slice(1, -1), in: ".release/config.json" }))],
});
