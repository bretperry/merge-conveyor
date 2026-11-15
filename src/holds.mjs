// Case-folded hold matching for a supplied policy.
// Used by: the conveyor CLI and the package tests.
// Exports: MAX_PR_FILES, BASE_HOLDS, PACKAGE_HOLDS, LANGUAGE_HOLDS, createHolds.
export const MAX_PR_FILES = 3000;
// Generic policy; project script patterns stay in the adapter.
export const BASE_HOLDS = [
  [/(^|\/)migrations?\//, "migrations"],
  [/(^|\/)prisma\//, "migrations"],
  [/(^|\/)(db\/migrate|alembic)\//, "migrations"],
  [/(^|\/)schema\.sql$/, "migrations"],
  [/(^|\/)infra\//, "infra"],
  [/\.tf$/, "infra"],
  [/(^|\/)Dockerfile[^/]*$/, "infra"],
  [/(^|\/|[-_.])auth(?!or)/i, "auth"],
  [/^\.github\//, "CI"],
  [/^\.githooks\//, "hooks"],
  [/^\.husky\//, "hooks"],
  [/^\.claude\/hooks\//, "hooks"],
];
export const PACKAGE_HOLDS = [
  [/(^|\/)(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|bun\.lockb?|bunfig\.toml|\.npmrc|\.yarnrc(\.yml)?)$/, "dependencies"],
];
export const LANGUAGE_HOLDS = [
  [/(^|\/)(Gemfile(\.lock)?|poetry\.lock)$/, "dependencies"],
  [/(^|\/)(go\.mod|go\.sum|Cargo\.toml|Cargo\.lock|pyproject\.toml|uv\.lock|requirements[^/]*\.txt|Package\.swift|Package\.resolved)$/, "dependencies"],
  [/(^|\/)(build\.gradle(\.kts)?|settings\.gradle(\.kts)?|gradle\/libs\.versions\.toml)$/, "dependencies"],
];
// Whether a pattern holds a path. Each path is read as written and lower-cased: a Mac checkout's file
// system folds case, so committing `CI/deploy.mjs` overwrites `ci/deploy.mjs`; upper-casing first folds `ſ` (long s) to `s` too.
const matches = (pattern, path) => pattern.test(path) || pattern.test(path.toLowerCase()) || pattern.test(path.toUpperCase().toLowerCase());

export const createHolds = (patterns) => {

  // The held reasons for a list of changed paths, each once, in pattern order.
  const heldBy = (paths) => [...new Set(patterns.filter(([pattern]) => paths.some((path) => matches(pattern, path))).map(([, why]) => why))];

  // The paths in a list that one held class covers.
  const pathsHeld = (paths, why) => paths.filter((path) => patterns.some(([pattern, reason]) => reason === why && matches(pattern, path)));

  return { heldBy, pathsHeld };
};
