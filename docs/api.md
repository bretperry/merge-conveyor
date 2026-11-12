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
| `pause()`, `resume()` | none | `Consent`: kind, changed, expiry |

A version 1 snapshot has `repo`, `base`, `observedAt`, `complete`, `globalBlockers`, `entries`, `nextAction`, and `nextActionKnown`. Each entry has a number, title, URL, full head SHA, state (`ready`, `waiting`, `blocked`, `unknown`), nullable position and reasons. Each reason has `code`, `message`, and optional `checkUrl` and `retryAt`. An action contains `kind` (`merge` or `update`), PR number and head SHA. `unknown` tick and clearance outcomes require reconciliation; see [recovery](operator-recovery.md).

## Configuration

The default file is `.conveyor.json` at the checkout root. `--config PATH` or `createClient({ configPath: PATH })` selects another file. `createClient({ config: {...} })` overrides file fields; `cwd` selects the checkout. Unknown keys are errors.

| Field | Default | Meaning |
| --- | --- | --- |
| `repo` | inferred from GitHub `origin` | `owner/repo`; if supplied it must match origin |
| `base` | `main` | target branch |
| `baseWorkflow` | `ci.yml` | GitHub Actions workflow for base push health |
| `releaseBranch` | unset | if set, an open PR to this distinct branch freezes writes |
| `mergeMethod` | `merge` | `merge`, `squash`, or `rebase` |
| `autoUpdate` | `false` | opt in to updating stale PR branches |
| `clearancePublisherId` | unset | positive numeric GitHub user ID; required for clear and resume |
| `clearanceContext` | `conveyor/cleared` | status context prefix; Conveyor scopes it to PR and base |
| `consentHours` | `8` | integer 1–24 |
| `stateName` | `conveyor` | filename stem for journal, log, and lock |

`createClient` also accepts synchronous `policy({ repo, base, action, paths })`, which must return `true` to allow a worker write, and synchronous `notify({ repo, base, message })`. The policy may veto a write; it does not override holds or GitHub rules. Notification messages can include PR numbers, titles, failure details and operational state; protect the destination. Delivery failures are queued and retried; see [recovery](operator-recovery.md).

## CLI results

`--json` emits the same `Result` shape. Exit codes: `0` for a result, including ordinary idle/blocked states; `1` for operation errors, unhealthy doctor or corrupt status; `2` for usage/invalid input; `3` for an unconfirmed tick or clearance write. An `unknown` value can therefore be an `ok: true` result with exit 3. Progress goes to stderr on a terminal.

The legacy `createConveyor(config)` adapter and its `main` interface remain available for existing integrations. Its extensive callback contract, constants and options are declared in `src/index.d.mts`; it is distinct from `createClient` and its own legacy CLI exit codes differ. Preserve existing adapters and compare behavior before switching timers.
