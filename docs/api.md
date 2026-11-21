# JavaScript API and configuration

The package exports `createClient`, `createConveyor` (legacy), and `EXIT_CODES`. Type declarations in `src/index.d.mts` define all public fields and are the authoritative full reference. Import from `merge-conveyor` in an ES module:

```js
import { createClient } from "merge-conveyor";

const client = createClient({ cwd: "/path/to/worker-checkout" });
const result = await client.queue();
if (!result.ok) console.error(result.error.code, result.error.message);
else console.log(result.value.nextActionKnown, result.value.nextAction);
```

Every client operation returns `Promise<Result<T>>`: `{ ok: true, value: T }` or `{ ok: false, error: { code, message, retryAt? } }`. Treat unrecognized codes as displayable strings. A successful result can still describe a blocked, incomplete, or unknown state. Avoid assuming that `nextAction: null` means an empty queue: check `complete`, `nextActionKnown`, and `globalBlockers`.

| Operation | Input | Successful value |
| --- | --- | --- |
| `queue()` | none | `QueueSnapshot`, scheduler order followed by unranked entries |
| `preview()` | none | `QueueSnapshot`, with proposed `nextAction`; no write |
| `explain({ number })` | positive PR number | `Explanation`: entry, checks, completeness, holds, next step, and snapshot context |
| `status()` | none | `WorkerStatus`: journal health, timestamps, action, retry, operation, consent and blockers |
| `doctor()` | none | `Diagnostics`: `healthy` and checks; a successful result can be unhealthy |
| `report({ days })` | optional integer 1–90, default 7 | `MergeReport`: counts, percentiles, completeness; up to 200 merges |
| `tick()` | none | `TickOutcome`: `merged`, `updated`, `idle`, `blocked`, or `unknown` |
| `clear({ number, headSha })` | PR and full reviewed SHA | `cleared`, `already_cleared`, or `unknown` |
| `pause()`, `resume()` | none | `Consent`: kind, changed, expiry; resume lasts `consentHours` |
| `window({ hours, confirm })` | integer 1–168 or `"off"`; `confirm` required for hours | `Consent`; opens an expiring window, or pauses for `"off"` |
| `approve({ numbers, confirm })` | distinct PR numbers; `confirm` required | `Approvals`: each PR's head and held classes, and when the 24-hour yes expires |

`window` and `approve` record a person's yes, so they act only when `confirm` resolves to exactly `true`. The CLI's confirm needs a terminal on stdin and on the prompt stream (stdout, or stderr under `--json`) and the typed word `yes`. That stops a plain non-interactive shell. It is not a security boundary against the same user: a program that drives a pseudo-terminal can type `yes`, a library caller supplies its own `confirm`, and anyone who can write the git directory can edit `conveyor-consent.json` (a `window` record may run to 168 hours) or `conveyor-approvals.log`. `approve` writes one record per held class a PR touches, bound to the head it showed you; a push that leaves those paths alone keeps the yes. A PR touching no held path is refused. The confirm wait does not count against the read budget: the re-read after it gets a fresh 15 seconds and 160 commands. Reading a pull request takes about 5 commands, so by command count one `approve` covers at most 31 pull requests (the 15-second budget may run out sooner); more than the budget returns `data_unavailable` and records nothing.

A version 1 snapshot has `repo`, `base`, `observedAt`, `complete`, `globalBlockers`, `entries`, `nextAction`, and `nextActionKnown`. Each entry has a number, title, URL, full head SHA, state (`ready`, `waiting`, `blocked`, `unknown`), nullable position and reasons. Each reason has `code`, `message`, and optional `checkUrl` and `retryAt`. An action contains `kind` (`merge` or `update`), PR number and head SHA. `unknown` tick and clearance outcomes require reconciliation; see [recovery](operator-recovery.md).

## Configuration

The default file is `.conveyor.json` at the checkout root. `--config PATH` or `createClient({ configPath: PATH })` selects another file. `createClient({ config: {...} })` overrides file fields; `cwd` selects the checkout. Unknown keys are errors.

| Field | Default | Meaning |
| --- | --- | --- |
| `repo` | inferred from GitHub `origin` | `owner/repo`; if supplied it must match origin |
| `base` | `main` | target branch |
| `baseWorkflow` | `ci.yml` | GitHub Actions workflow for base push health |
| `releaseBranch` | unset | if set, an open PR from the configured base into this distinct release branch freezes worker merges and updates |
| `mergeMethod` | `merge` | `merge`, `squash`, or `rebase` |
| `autoUpdate` | `false` | opt in to updating stale PR branches |
| `clearancePublisherId` | unset | positive numeric GitHub user ID; required for clear and resume |
| `clearanceContext` | `conveyor/cleared` | status context prefix; Conveyor scopes it to PR and base |
| `consentHours` | `8` | integer 1–24 |
| `stateName` | `conveyor` | filename stem for journal, log, lock, and event feed |

`createClient` also accepts synchronous `policy({ repo, base, action, paths })`, which must return `true` to allow a worker write, and synchronous `notify({ repo, base, message })`. The policy may veto a write; it does not override holds or GitHub rules. Notification messages can include PR numbers, titles, failure details and operational state; protect the destination. Delivery failures are queued and retried; see [recovery](operator-recovery.md).

## Event feed

Each `tick` appends one JSON object per line to `<stateName>.events.ndjson` in the Git common directory. Tail it to follow the worker without calling GitHub. `tick --dry-run`, `queue` and `explain` never write to it.

| `type` | Fields | When |
|---|---|---|
| `tick_started` | none | the tick holds the worker and consent locks |
| `intent_journaled` | `action { kind, number, headSha }`, `baseSha` | the journal has saved a merge or update, before the write is sent |
| `tick_finished` | `outcome`, `commands`, optional `code`, `action`, `result` | every tick, including a locked, paused or failed one |

Every event also has `schemaVersion: 1` and `at`. `outcome` is the tick result kind (`merged`, `updated`, `idle`, `blocked`, `unknown`) or `error`. `code` is the stable reason or error code. `commands` counts the Git and GitHub commands the tick ran. `result` is the merged or updated outcome; `action` is the unconfirmed write.

Events hold PR numbers, SHAs and codes only: no titles, messages or command output. The feed is best effort. A failed append never fails a tick, so the journal and `status` remain the record of intent and outcome. At 1 MiB the file moves to `.events.ndjson.1`, replacing the previous one. Skip a line that does not parse; a reader can race an append. Treat unknown `type` values and fields as ignorable.

## Watch

`conveyor watch [--calm]` opens a read-only full-screen view: the queue as crates moving through clearance, CI, a sync bay and a ready dock into the merge core, with telemetry and the recent event log. It needs an interactive terminal of at least 30×26 (84×26 for the wide layout). Keys: `q` quit, `c` calm (slower, fewer effects). It refuses `--json`, pipes and scripts; use `queue --json` and `status --json` there.

- **Reads:** `queue` and `status` every 15 seconds (each within the normal read budget), `report --days 7` every 5 minutes, and the event feed every second. They run in child processes, so a slow GitHub call never freezes the display.
- **Writes:** none. It never ticks, clears, pauses or resumes.
- **Next tick:** Conveyor does not know the scheduler, so the countdown is the median gap between the last five `tick_started` events. It shows `last Ns ago` until two ticks have been seen.
- **States:** paused, empty, partial, corrupt journal and unconfirmed write have their own labels. Colour always comes with a text label.

The library equivalent of the feed is `client.events({ limit })`, which returns the feed path and the newest events.

## CLI results

`--json` emits the same `Result` shape. Exit codes: `0` for a result, including ordinary idle/blocked states; `1` for operation errors, unhealthy doctor or corrupt status; `2` for usage/invalid input; `3` for an unconfirmed tick or clearance write. An `unknown` value can therefore be an `ok: true` result with exit 3. Progress goes to stderr on a terminal.

## Embedded mode

A host project that passes its own adapters (functions, which JSON can't carry) points `--config` at an ES module instead of a JSON file: `conveyor --config scripts/conveyor.config.mjs tick --dry-run`. The module's default export is a `createConveyor` config, and the bin runs that config's line CLI: `tick [--dry-run]`, `status [--json]`, `report [--days N]`, `clear <pr> <sha>`. `status --version` prints the installed version without loading the module, so a host can check its pin. A module that fails to load or validate exits `2` and never ticks; under `status --json` that failure is one `{ ok: false, error }` document. `--version` prints the version too.

Trust: the module is code, and it runs when it is imported, before the worker's own clone check. So a real `tick` takes `--base <branch>` and loads the module only when the checkout is clean, on that branch, at its upstream's tip, and the module is a tracked file inside it, not flagged assume-unchanged or skip-worktree; the module's `base` must equal `--base`. The check and the import are two steps, so a write to the checkout between them isn't caught: keep the worker checkout to the timer alone. Anything else exits `2` without importing it. Read commands (`status`, `report`, `tick --dry-run`) and `clear` load it from any checkout, as running any of the repo's scripts would: run them only in a checkout you trust.

`status --json` writes one document: `{ ok: true, value }` or `{ ok: false, error: { code, message } }`. A version 1 `value` has `schemaVersion`, `version`, `base`, `release`, `switch` (`variable`, `on`, `value`, `unreadable`, `why`), `consentUntil`, `lastTickAt`, `clone` (`ok`, `problem`), `operation` and `updating` (each `kind`, `number`, `headSha`, `since`, or `null`), `voided`, `prs` (each `number`, `kind`, `headSha`, `detail`), `ship` (`blocked`, `why`), `baseGreen` (`green`, `why`), and `recent` (the log's last 10 lines).

The module's config takes only the fields `src/index.d.mts` declares; any other key is an error. Renamed projects keep their records: `stateAliases` lists older state-file stems (distinct, none equal to `stateName`), read when the current one is missing and moved to the current name on the first save (when both are there, the tick refuses until one is removed), whose locks a tick also takes; each lock also holds the file-style `<name>.lock` an older timer reads, so that timer stands down, and `createApprovals({ approvalsLogAliases })` lists older approval-log names, read as well. Writes always use the current names.

With `mergeApprovals: true` in the config (default `false`), a `merge` record in the approvals log (`{ pr, scope: "merge", head, expires }`, written by the host's own approve tool) is consent for that one PR at exactly that head while the clone's window is off: the tick merges it as it would inside a window, with its holds, clearance, CI and the final reads unchanged. It never covers an update (a new head), and a push voids it. The `commando` adapter's options carry `consent: "window" | "approval"`, and an adapter must honor it: set `mergeApprovals` only when yours does, since a 0.1-era adapter that ignores `consent` would merge with its own switch off. The repo switch still comes first: with it off, nothing merges, approved or not. Without the opt-in a `merge` record keeps its 0.1 meaning (read by the host, never by the tick).

The package also exports `createApprovals`, `createHolds` with `BASE_HOLDS`, `PACKAGE_HOLDS`, `LANGUAGE_HOLDS` and `MAX_PR_FILES`, `createMerge`, and `ciVerdict` for hosts that build their adapters on them.

The legacy `createConveyor(config)` adapter and its `main` interface remain available for existing integrations. Its extensive callback contract, constants and options are declared in `src/index.d.mts`; it is distinct from `createClient` and its own legacy CLI exit codes differ. Preserve existing adapters and compare behavior before switching timers.
