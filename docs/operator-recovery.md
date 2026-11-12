# Operator recovery

Use this guide for a stalled worker, uncertain GitHub write, or upgrade. You need access to the trusted checkout, its Git common directory, the scheduler, GitHub PR/check history, and the configured publisher where clearance is needed. Keep one active worker per repository.

## Diagnose and stop

1. Stop the scheduler and run `conveyor pause`. If a tick or consent change holds a lock, wait for it to finish and retry. Confirm all worker processes and old schedulers have stopped before maintenance.
2. Run `conveyor status`, `conveyor doctor`, `conveyor queue`, and `conveyor explain 42` as applicable. Fix authentication, permissions, strict required branch checks, base push workflow, clean current checkout, CI, or expired consent as indicated. Use the full current reviewed SHA for a fresh clearance. The standalone client cannot grant separate held-path approval; escalate to the maintainer's established process.
3. A queue over 200 PRs, over 99 check contexts per PR, unavailable evidence, exhausted read budget, or a PR over 300 changed files can prevent a reliable decision. Reduce the input or fix access and inspect again. The worker checkout must not contain submodules.

## Unconfirmed write or corrupt journal

- Exit 3 or an `unknown` outcome means GitHub may have accepted the write. Inspect the named PR, head, base, merge state and GitHub history. For clearance inspect the status on the exact head and its publisher. Do not issue a duplicate write on an assumption of failure.
- `status` reports an in-flight operation. The journal is written before a merge or update; a later tick reconciles it against GitHub before another write. Keep the journal and let reconciliation resolve the outcome after access is restored. If GitHub cannot establish the outcome, keep the worker stopped and escalate to the repository maintainer.
- The journal and logs live in the Git common directory (`git rev-parse --git-common-dir`), normally `conveyor.json` and `conveyor.log`; `stateName` changes the stem. Consent and approval records also live there. Back up the entire directory's Conveyor files before intervention. `corrupt` or unsupported state blocks writes and preserves the original bytes. Do not delete or replace a journal until the outstanding operation has been reconciled against GitHub. Restore a verified compatible backup only after reconciliation; otherwise retain the evidence and escalate for manual repair. Do not remove a lock while a worker may still be alive.

## Notifications

The library's synchronous `notify` callback receives repository, base and message. Failure or absence queues alarms in the journal for later delivery; alarms are deduplicated and the bounded outbox holds 50, with older dropped messages retained in the log. The standalone CLI has no notification callback configuration. Monitor status and the log, or run a library integration with a synchronous destination. Never assume a notification was delivered merely because a tick completed.

## Upgrade and rollback

1. Record the existing package pin, configuration, adapter, scheduler and Git common directory. Stop both old and new workers, pause where supported, and back up the journal, consent, approvals and logs. Reconcile any outstanding GitHub write before changing versions.
2. Install the new local tarball separately. Keep the legacy `createConveyor` adapter and existing integration available. Compare config, policy, state and notification behavior, then run the new `doctor`, `queue` and `tick --dry-run` against the same repository while workers remain stopped. Legacy unversioned journals are recognized; unsupported/corrupt state must be resolved before writing. Verify compatibility with the previous version before assuming it can read newer state.
3. Enable only one scheduler after the comparison and explicit operator consent. To roll back, stop both versions, pause, reconcile any pending write with GitHub, then restore the previous package pin and worker configuration. Preserve the latest journal and records; do not blindly restore an older journal that omits a completed or pending operation. Check status and preview under the previous version before resuming. If compatibility or the outcome is uncertain, leave both stopped and escalate.
