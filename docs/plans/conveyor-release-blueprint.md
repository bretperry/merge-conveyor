# Blueprint: Conveyor public release

**Status:** Draft for review. The CLI and API below are proposals.

Conveyor should give maintainers and agents a reliable way to see what is waiting, why it is blocked, and what the next tick would try. The first release targets GitHub repositories with one active worker per repository and a standalone Node CLI and JavaScript library.

**Lapidary:** before release (proposed)

| Behavior | Tier | Test |
|---|---|---|
| Eligibility, priority, holds, retry timing, and stale branch policy | 1 | Deterministic policy fixtures and fake clock |
| Queue, explain, and preview agree with tick | 1 | Shared snapshot fixtures and CLI/API contract tests |
| Crash, corrupt state, duplicate tick, timeout, and failed reads | 1 | Fake GitHub and local state failure tests |
| Protected branch, exact-head clearance, and real CI | 2 | Disposable GitHub repo and installed npm tarball |
| First run and recovery are understandable | 3 | Fresh human and agent follow only the shipped docs |

| Phase | What | After | Model | State |
|---|---|---|---|---|
| 0 | Settle scope and public contract | — | deep (xhigh) | landed; owner approved 2026-11-11 |
| 1 | Harden merge, state, and recovery | 0 | deep (xhigh) | |
| 2 | Ship the CLI, queue, and typed API | 1 | workhorse (high) | |
| 3 | Write public docs and clean up comments | 2 | workhorse (medium) | |
| 4a | Rehearse install, upgrade, and release | 3 | deep (high) | |
| 4b | Polish CLI and docs | 4a; preview approved | workhorse (medium) | |
| 5 | Make public and publish | 4b; license decided | — (human) | |

Suggested Codex assignments: GPT-6.1 Sol Extra High for phases 0 and 1, Sol High for phases 2 and 4a, Terra Medium for phases 3 and 4b. Use Terra High as a fresh user during phase 4a.

## Need

- **Solo maintainer:** Review an exact commit, see what is next, and pause the worker.
- **Team:** Use its GitHub checks, branch names, merge method, and optional policy for sensitive changes.
- **Agent:** Discover commands from help, read stable JSON, and know whether to wait, request approval, or investigate CI.
- **Operator:** Confirm the worker is alive, diagnose a stuck update, and recover without losing the record of an attempted merge.
- **Success:** A fresh maintainer and an agent independently install the package, explain a blocked PR, and land a cleared PR on a disposable repo. → verify: phase 4a rehearsal.
- **Deferred:** Hosted service, multi-worker coordination, other forges, native GitHub merge queue integration, batching, and IDE or agent-specific plugins.

## Current baseline

Reviewed commit `53a86c555fa88584ad640c16fe47053d5e2ea7f9`. The core can select one merge or update per tick, track retries and in-flight work, gate on CI and clearance, and report merge timing. The package has no executable or README. The library requires a dozen callbacks and a regular expression. Status prints a capped list of open PRs without queue priority. Merge mechanics still assume particular branch names, and PR CI does not run the package tests.

## Options and pick

| Shape | Cost and tradeoff |
|---|---|
| Library only | Smallest implementation. Every user has to build and maintain a runner and queue interface. |
| CLI and library, one local worker | Recommended. One policy implementation serves the timer, terminal, and agent. Operators provide a persistent clone and scheduler. |
| Hosted service or GitHub App | Centralized operation, with additional credential, deployment, tenancy, and storage work. |

## Terminal mockup

```text
$ conveyor queue
example/widgets → main · 3 open PRs
NEXT     #42  Merge candidate     Required checks passed
WAITING  #43  CI pending          integration
BLOCKED  #44  Approval required   database migration

Run conveyor explain 44 for details.
```

- **Empty:** “No open pull requests target main.”
- **Paused:** “Conveyor is paused. Next action: none.” Continue showing independently known PR state.
- **Partial:** “Queue incomplete. GitHub rate limited this request. Next action: unknown.” Include retry guidance when known.
- **Offline:** “Queue unavailable. Could not reach GitHub.” Return a documented error.
- **Slow:** On a terminal, show progress on stderr. JSON consumers receive a single result on stdout when the operation ends.
- **Narrow or long titles:** Wrap or abbreviate titles while retaining PR number, state, and reason. Plain text works without color. No browser screens, animations, or interactive focus.

## Proposed API

```ts
type Reason = { code: string; message: string; checkUrl?: string; retryAt?: string };
type Entry = {
  number: number; title: string; url: string; headSha: string;
  state: 'ready' | 'waiting' | 'blocked' | 'unknown';
  position: number | null; reasons: Reason[];
};
type Action = { kind: 'merge' | 'update'; number: number; headSha: string };
type QueueSnapshot = {
  schemaVersion: 1; repo: string; base: string; observedAt: string;
  complete: boolean; globalBlockers: Reason[]; entries: Entry[];
  nextAction: Action | null; nextActionKnown: boolean;
};
type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string; retryAt?: string } };
```

| CLI | Library operation and result |
|---|---|
| `queue [--json]` | `queue()` returns a snapshot in scheduler order, with unranked entries after candidates. |
| `explain <pr> [--json]` | `explain({ number })` returns PR state, check details, holds, and the next step. |
| `status`, `doctor`, `report [--days N]` | Worker and config health, setup diagnostics, and bounded merge timing statistics. |
| `tick --dry-run` | `preview()` returns the snapshot and proposed action without mutation. |
| `tick` | `tick()` returns a discriminated outcome for merged, updated, idle, blocked, or unknown after a write. |
| `clear <pr> <sha>` | `clear({ number, headSha })` records clearance for the reviewed full SHA. Return already cleared for repeated requests. |
| `pause`, `resume` | Set the explicit worker switch, subject to operator authorization. Repeating the same desired state is safe. |

- **Errors and states:** Distinguish invalid config, missing auth, insufficient permission, rate limit, unavailable data, changed head, and corrupt state. Idle, paused, and waiting are ordinary outcomes. Publish exit codes and stable reason codes. Treat unknown reason codes as displayable strings.
- **Completeness:** Page through GitHub results within a documented time and request budget. Surface incomplete inputs and withhold the predicted next action when missing information could affect it. A complete empty queue is a successful result.
- **Auth:** Document read permissions separately from clearance, operator controls, and worker writes. Clearance is tied to a SHA. Define the trusted status publisher, and keep GitHub branch protections authoritative for required CI.
- **Compatibility:** Use git, authenticated `gh`, and Node 22+. Use the same contract for the library and CLI. Add optional fields within a schema version. Public operation names, shapes, error codes, and exit codes become compatibility commitments when released.

## Units and data

- **Core:** Pure policy takes a snapshot and explicit time, then returns ranked entries and a proposed action. Queue, explain, preview, and tick share this decision logic. The write path rechecks mutable inputs.
- **Adapters:** GitHub reads and writes, local state, optional policy hooks, and notification delivery. Ship working defaults. Keep an import boundary test and test each boundary with fakes.
- **State:** Store the schema version, last tick, retry timestamps, in-flight operation and expected head, and notification state in the worker's git common directory. Keep existing retry and notification retention unless phase 0 establishes a migration need. Preserve corrupt bytes, block writes, and provide a recovery path. Detect older state explicitly and verify migration and rollback against fixtures.
- **Privacy:** Do not persist credentials. Avoid printing sensitive config or raw authentication errors in machine output. Document what the notification hooks receive.

## Performance budget

Initial targets to validate in phase 4a: help and version in 250 ms locally with no network; queue at p95 under 5 s on a 20-PR fixture with 100 ms simulated GitHub calls; 15 s total read budget for interactive queue and explain. On budget exhaustion return a partial snapshot or a typed error. Measure with an installed package and count requests. Keep worker timeouts separate and bounded.

## Failure-mode sweep

| Risk | Design response | Verification |
|---|---|---|
| Head or base moves | Pin the full head SHA. Require strict GitHub checks on the base for direct merge and reconcile the actual GitHub outcome. | Tier 1 changed-head fixture; tier 2 strict branch protection |
| Two ticks or a lost response | Lock the worker checkout, support one active worker per repository, and reconcile before repeating a write. | Tier 1 concurrent tick and lost response cases |
| State corruption or interrupted update | Save intent before a write, preserve corrupt state, and stop merge writes until repaired. | Tier 1 corrupt and crash recovery cases |
| Slow API, rate limit, or missing checks | Bound reads, show unknown state, and stop writes when required evidence is unavailable. | Tier 1 timeout and partial response cases |
| Wrong identity or policy | Document token roles, use a trusted worker checkout, and respect GitHub protections without bypass. | Tier 2 least-privilege setup and rejected write |
| Empty queue or many PRs | Explicit completeness, stable sorting and tie breaks, bounded pagination. | Tier 1 zero, one, and multi-page fixtures |
| Terminal readability and accessibility | Text labels, readable narrow output, and progress on stderr. Browser scroll and layout are inapplicable. | Tier 1 output fixtures; tier 3 fresh-user pass |
| Upgrade and rollback | Preserve legacy adapter and state compatibility where required. Keep the previous package pin and verify dry-run parity. | Tier 1 old-state fixture; tier 2 rollout rehearsal |

## Observability and rollout

Expose last successful tick, last action, blocker, retry time, and state health through status and JSON. Preserve alarm deduplication and document notification delivery failures. Roll out preview first, then enable one worker in a disposable repo. Compare behavior with the existing downstream integration before moving its timer. Roll back by pausing, reconciling any outstanding write in GitHub, and restoring the previous package and worker config.

## Decisions and human checks

- **Release license:** Owner decides whether to retain FSL-1.1-MIT and label the release source-available, or choose an OSI-approved license for launch. Match LICENSE, package metadata, contribution policy, and the release gate.
- **Contract:** Owner reviews proposed CLI names, queue output, and which policy hooks are public in phase 0. Resolve merge methods, branch rule prerequisites, credential roles, and compatibility needs before freezing the interface.
- **Preview:** Owner approves the installed CLI and documentation from phase 4a before phase 4b.
- **Publish:** Owner approves visibility and the first npm release after rehearsing install, rollback, and the package and history checks.

## Phase 0 — Settle scope and public contract

**Model:** deep · **Thinking:** xhigh. The operation and schema commitments affect every later phase.

Research existing downstream call sites and state compatibility. Record the supported branch rules, CI providers, token roles, merge methods, and defaults. Review the mockup, error table, and use cases.

**Done when:** Each persona has a supported path or an explicit scope decision → verify: walk through the contract and record owner decisions.

**Owner approval, 2026-11-11.**

- Keep the `conveyor` CLI and the typed JSON contract above. Queue, explain, preview, and tick share the scheduling policy. The public policy hook may veto a write, with a separate notification hook.
- Support direct merges on bases with strict GitHub checks enforced for the worker. The worker has no bypass rights. Configure the merge method (`merge`, `squash`, or `rebase`). GitHub Actions supplies base health. PR checks can come from Actions or an external provider reporting through GitHub.
- Default to paused. Resume grants expiring consent. A trusted publisher clears the full reviewed SHA, and held paths require separate approval. Automatic branch updates are opt-in and require fresh clearance.
- Release standalone first. Verify downstream rules, state, and behavior parity before switching existing timers.

The solo maintainer reviews and clears a SHA before resuming the worker. Teams configure GitHub checks and a merge method. Agents inspect and explain the queue using typed results. Operators use status, pause, and reconciliation to recover.

## Phase 1 — Harden merge, state, and recovery

**Model:** deep · **Thinking:** xhigh. The failure cases can change real repository state.

Work in merge, tick, CI, and state modules. Remove hardcoded branches, guard corrupt state and failed reads, and verify write reconciliation and single worker behavior. Add deterministic tests and run them in PR CI.

**Done when:** Tests cover changed heads, moved bases, missing checks, holds, forks, retries, crashes, and duplicate ticks → verify: `npm test` and phase 4a branch protection rehearsal.

## Phase 2 — Ship the CLI, queue, and typed API

**Model:** workhorse · **Thinking:** high. CLI and library callers need the same semantics.

Implement the executable, defaults, queue inspection, explanations, diagnostics, and typed results. Reuse the core selection policy and provide a migration path for existing callers.

**Done when:** Text and JSON reflect the same queue and preview never writes → verify: package contract fixtures, including empty, partial, paused, and unknown-write cases.

## Phase 3 — Write public docs and clean up comments

**Model:** workhorse · **Thinking:** medium. Translate project-specific language into public commands and policy.

Write README, minimal config, API reference, agent walkthrough, operator recovery guide, and contribution guidance. Replace internal vocabulary and private examples. Keep comments that explain invariants and tradeoffs.

**Done when:** The docs explain installation, privilege boundaries, and how to get a stuck PR moving → verify: trace each documented command and example to the shipped CLI or API.

## Phase 4a — Rehearse install, upgrade, and release

**Model:** deep · **Thinking:** high. Use an independent Terra High reviewer for the first run.

Pack and install in a clean directory, validate the tarball and commit history, and rehearse release and rollback. Test a disposable protected repo with required CI, plus compatibility with the existing integration.

**Done when:** A human and an agent each complete queue inspection through merge using the README → verify: rehearsal transcripts, package contents, CI run, and preview approval.

## Phase 4b — Polish CLI and docs

**Model:** workhorse · **Thinking:** medium. Revise copy using evidence from the rehearsal.

Fix confusing terms, help output, narrow terminal wrapping, and recovery instructions. Update examples to match the final contract.

**Done when:** The approved copy matches observable behavior → verify: narrow and wide CLI transcripts and documented command examples.

## Phase 5 — Make public and publish

**Model:** — · **Thinking:** human. The owner controls the release.

Confirm release terms, repository visibility, package provenance, and first version. Publish the approved artifact.

**Done when:** The public repo and package advertise the same version and license → verify: inspect both listings and install the published version in a clean directory.
