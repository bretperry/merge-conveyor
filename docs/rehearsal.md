# Conveyor Phase 4a rehearsal

Source commit `451bca7f492dbe4148d22858e88ce3adcf0a84e8` · 2026-11-12

## Package and history

- Packed `merge-conveyor@0.1.0` from a Git archive of the exact source commit. Independently rebuilt the tarball and matched every byte. Clean offline install and all 106 source tests passed.
- SHA-256 `13e516ed96fc6e433a93b350e7d2c167f27b08074c8167f4a1072264948a0e8e`. The 55,506-byte archive contains 24 entries covering the CLI and library, type declarations, package metadata, public docs, license and config example.
- Git connectivity passed for all 25 commits reachable from the source commit. Redacted secret scans passed on the tarball and on the 19 non-merge commit patches inspected by Gitleaks. The merged docs PR passed the full Package gate at its reviewed head (run `43245517480`). The full release gate passed locally on the exact rehearsal source commit, which adds only a blueprint status update after the docs merge.
- Ran `npm publish --dry-run --offline --ignore-scripts` on the packed archive against a reserved test registry with empty npm config. The dry run exited successfully.

## Installed CLI read budgets

Each timing includes process startup and JSON output. The simulated GitHub shim waited 100 ms per invocation unless indicated. The Git commands ran in a local fixture checkout. p95 uses nearest rank.

| Exercise | Samples | Observed | Commands per sample | Result |
|---|---:|---:|---:|---|
| Help | 20 | p95 41 ms | 0 GitHub, 0 Git | Within 250 ms |
| Version | 20 | p95 39 ms | 0 GitHub, 0 Git | Within 250 ms |
| Queue, 4 cleared and 16 awaiting clearance | 20 | p95 4.39 s | 37 GitHub, 13 Git | Complete 20-entry snapshot and known next action in every run |
| Queue, 20 cleared | 20 | p95 15.08 s | 129–133 GitHub, 13 Git | Missed 5 s. 16 partial and 4 complete snapshots, all with the verified first action. |
| Queue, delayed second page | 1 | 15.06 s | 2 GitHub, 3 Git | Partial snapshot retained PR #7 with `read_timeout` and unknown next action |
| Explain #7, delayed second page | 1 | 15.07 s | 2 GitHub, 3 Git | Partial result retained PR #7 with `read_timeout` and unknown next action |
| Queue, 25 cleared, zero shim delay | 1 | 0.67 s | 147 GitHub, 13 Git | Stopped at 160 commands. Snapshot marked incomplete, with the already verified first action. |

The measurements above used a native shim to keep process startup overhead low. The mixed queue met the 5 s target. A higher fraction of cleared PRs adds serial evidence reads and can reach the 15 s read budget.

## Protected repository rehearsal

The private synthetic fixture used real Actions checks, an up-to-date base checkout and GitHub protection enforced on the fixture worker. The same authenticated identity exercised both publisher and worker roles.

| Fixture | Verification | Evidence |
|---|---|---|
| Configured base `main` | Required `rehearsal-ci` with strict checks and administrator enforcement. Initial base push succeeded. | Actions run `43247078419` |
| PR #3 into `main` | Required CI failed. An exact-head merge request returned HTTP 405, `Required status check "rehearsal-ci" is failing.` PR remained open. | Actions run `43247219215` |
| PR #4 retargeted from `main` to `outside` | CI passed. The alternate base was locked and enforced for administrators. An exact-head merge request returned HTTP 405, `Cannot change this locked branch`. PR remained open on `outside`. | Actions run `43247229123` |
| Independent fresh-user agent, PR #1 | Installed from the README, ran doctor and inspected queue and explain. Reviewed and cleared the exact head, resumed, previewed the merge, ticked once, verified the merge in GitHub and paused. | PR CI `43247198597`, post-merge base CI `43247798927` |
| Owner, PR #2 | Independent README walkthrough and permissions and rollback checks pending. A dedicated checkout is current at the base tip. | Refreshed exact-head CI `43247992184` passed |

### Fresh-user walkthrough transcript

1. `npm install --prefix … …tgz` succeeded with a scratch npm cache after the default cache returned `EPERM` in the sandbox.
2. `conveyor doctor` reported healthy. `conveyor queue` returned a complete, paused snapshot. `conveyor explain 1` showed green checks and `clearance_required`.
3. After reviewing the synthetic diff, `conveyor clear 1 c92aec5c1f6b1b95e60acdaab3e685bee9c801c9` recorded clearance. `conveyor resume` activated consent and `conveyor tick --dry-run` selected PR #1 at that head.
4. `conveyor tick` confirmed the merge. GitHub returned `MERGED` at `2026-11-12T15:26:22Z` and merge commit `aa8c5a7cbcd0a26744633a74e826040107cbc1ca`.
5. `conveyor pause` and `conveyor status` confirmed paused consent and no in-flight operation. The pre-merge checkout was behind the new base tip and the base was settling. The reviewer reported no README gaps.

## Reconciliation and downstream rollback

- In a separate clean checkout with both worker versions stopped, staged a pending journal record for the verified synthetic PR #1 merge. Confirmed the exact head, base and merge commit in GitHub and captured the pending record with `conveyor status`. One paused `conveyor tick` made one PR read, attempted zero writes, cleared the pending record and saved the matching merge commit as the last action. GitHub returned identical PR state before and after the replay. The candidate reported paused throughout.
- In a disposable copy of the downstream integration, the existing pin passed all 310 focused tests. Swapping the import to the installed candidate while preserving the actual adapter config passed 159 of 310. The candidate instantiated the adapter but did not expose `laneAuthorize` or retain the low-risk lane behavior. The rest of the failures include legacy contracts and mocks that differ from the candidate's stricter checks and new write API.
- In a simulated same-journal rollback with the real downstream adapter, the candidate upgraded the prior unversioned journal while switched off and retained retry and lane records. It reconciled a seeded pending merge with one PR read and recorded the confirmed merge time. The previous pin then read that reconciled versioned journal in status and dry run, showed the lane again, and preserved the merge time and records in a stopped tick. Neither version attempted a remote write.
- Restored the original engine import at the previous tracked source pin. The restored pin passed all 118 selected dry-run, lane and pending-lane cases. The existing downstream timer stays pinned.

Owner completion and preview approval are pending. The license and publication decisions remain with the owner.
