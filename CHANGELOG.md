# Changelog

## 0.2.1 (unreleased)

- `createApprovals`: file records carry `additions`, `deletions` and `hasPatch`; with `allModes`, old-side files carry `previousMode` from the merge base; `mergeBaseModes` reads it on its own.
- `createApprovals`: a `revoke: true` record voids every grant for its PR and scope written before it (a missing `at` voids too, and its expiry is ignored), and is never read as a grant. `mergeBaseModes` is exported from the package root.
- `ciVerdict(rollup, { lenient: true })` keeps the pre-0.2 reading (STALE and unknown outcomes read green, no `unknown`). Without the option nothing changes.
- `createMerge` also takes `BASE_BRANCH` and `SHIP_BASE_BRANCH`; `--ship` refuses a release branch equal to the base; `main` takes `wantHeads`, `earlyExit` and `onMerged`.

## 0.2.0 (unreleased)

- Embedded mode: `conveyor --config <module.mjs> <command>` runs a project's own config module, adapters included, through the line CLI (`tick`, `status`, `report`, `clear`).
- `status --json` in embedded mode: one document with the switch, consent, last tick, clone, in-flight work, each PR's class, the ship freeze and base health.
- A real embedded `tick` takes `--base <branch>` and loads its module only from a clean checkout of that branch at its upstream's tip.
- `status --version` prints the installed version, for checking a pin.
- Renamed projects keep their records: `stateAliases` (older state-file stems) and `approvalsLogAliases` (older approval-log names) are read; writes use the current names. A tick takes every name's lock, and refuses when state exists under two names.
- The first save moves an older name's state file to `stateName`.
- A tick also holds the file-style `<name>.lock` (refreshed each minute), so a timer still on older code stands down.
- `mergeApprovals: true` (opt-in, default `false`): a `merge` approval at a PR's exact head is consent for that PR alone while the window is off; it never covers an update, and the repo switch off still stops it. The `commando` adapter gets `consent: "window" | "approval"` and must honor it. Without the opt-in, existing `merge` records authorize nothing new.
- **Breaking for 0.1.x:** `createConveyor` rejects unknown config keys instead of ignoring them.
- Exports `createApprovals`, `createHolds` and the hold lists, `createMerge`, and `ciVerdict`.
- Since 0.1.0 on `dev`: `window` and `approve` commands, a typed event feed, `conveyor watch`, and the Node matrix.

## 0.1.0 (2026-11-12)

- First release.
