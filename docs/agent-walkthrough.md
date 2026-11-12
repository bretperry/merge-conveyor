# Agent walkthrough

Work in the trusted checkout with an authenticated `gh` and the installed `conveyor` executable. Obtain operator authorization before a write. For setup and credentials see the [README](../README.md).

1. Run `conveyor doctor --json`, then `conveyor queue --json`. Parse the single `Result` on stdout; progress may appear on stderr. If `ok` is false, report the error and retry guidance. Check `healthy`, `complete`, `nextActionKnown`, and `globalBlockers` before interpreting a candidate.
2. Run `conveyor explain 42 --json` for a specific PR. Report its full head SHA, checks, holds, reasons and next step. Waiting CI needs time or a CI investigation; a changed head needs a new review. A held path needs separate approval: standalone `clear` does not provide it. Escalate to the maintainer's established process.
3. Run `conveyor tick --dry-run --json` to preview. It does not write; a preview is not a guarantee because GitHub state can change before a tick. A paused worker can show PR details while reporting no action.
4. Only a trusted publisher who has reviewed the exact current SHA may run `conveyor clear 42 <full-reviewed-sha>`. It applies to this PR and base. An authorized operator may then run `conveyor resume` and `conveyor tick`. One tick attempts at most one merge or update. An automatic update requires a new review and clearance of the resulting head.
5. If a write reports `unknown` or exit 3, stop and follow [recovery](operator-recovery.md); do not assume failure or immediately repeat it. Use `conveyor status --json` to inspect the journal and consent.

Handle reason and error codes you do not recognize as displayable strings. An incomplete queue is not an empty queue; `nextActionKnown: false` means the next action is unknown.
