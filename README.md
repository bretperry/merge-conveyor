# Conveyor

**Hand off the merge queue.** Your agent opens GitHub pull requests and a trusted reviewer clears the commits that should ship. Conveyor watches CI and merges eligible PRs one at a time. Your agent can move on to other work while the queue runs.

For example, suppose you've cleared three PRs. One is ready, one is still testing, and one has a failing check. Conveyor can merge the ready PR, wait for CI on the updated base, and look again on the next scheduled tick. The PR still testing can move once it meets the merge requirements. The failing PR stays blocked until someone fixes it.

Your existing CI runs the tests and reports results to GitHub. Conveyor discovers open PRs from GitHub and uses those results to decide what can merge. Once you configure a scheduler and resume the local worker, it handles the routine polling and merge order while consent is active.

## Check status and see what's next

From your configured Conveyor checkout, run these commands:

```sh
conveyor status          # Is the worker paused? When did it last run?
conveyor queue           # Which pull requests are waiting?
conveyor explain 42      # What's holding up PR #42? Use your PR number.
conveyor tick --dry-run  # What would the next tick do?
```

For example, a newly configured worker may show:

```text
acme/widgets → main
Journal: ok
Last tick: none · last successful tick: none
Conveyor is paused.
```

The worker starts paused. Once it has run, status also shows the last action if one was recorded. When consent is active, status shows when it expires.

Use `conveyor status --json` for scripts. If your config lives outside the checkout, use `conveyor status --config /absolute/path/to/config.json`.

[Full HTML guide with examples for every command](README.html#commands)

## First run

1. Install Node.js 22 or later, Git, and the GitHub CLI (`gh`). Authenticate `gh` for github.com. From the Conveyor source checkout, build the local package before publication:

   ```sh
   npm pack
   ```

   In a separate directory, install the resulting tarball (replace the path with the actual file):

   ```sh
   install_dir=$(mktemp -d)
   npm install --prefix "$install_dir" /absolute/path/to/merge-conveyor-0.1.0.tgz
   export PATH="$install_dir/node_modules/.bin:$PATH"
   ```

2. Use a dedicated, persistent clone of the target repository with a GitHub `origin`. Use a checkout without submodules and keep it clean, on the configured base branch and at its current tip. Run the commands below from that checkout.
3. Copy [the minimal configuration](examples/conveyor.json) to `.conveyor.json` at the checkout root and replace the publisher ID and workflow with your own. Obtain the numeric ID of the authenticated publisher with `gh api user --jq .id`. Keep a local config ignored so the checkout stays clean. You can also place it outside the checkout and pass `--config /absolute/path/to/config.json` on every command.
4. Configure GitHub branch protection with strict required checks that apply to the worker identity. The worker must have no bypass rights. A successful GitHub Actions push workflow must exist for the current base tip; PR checks may be GitHub Actions or external checks reported to GitHub. Configure an allowed merge method.

   **Check what Conveyor can see while it is paused.** Run these read-only commands in the dedicated clone of the repository whose PRs you want to manage. Authenticate `gh` with the account the worker will use, so the checks reflect the access it will have.

   - `conveyor doctor` checks the setup, including GitHub access, required checks, and the base workflow. Address any `FIX` lines before enabling the worker.
   - `conveyor queue` lists open PRs targeting the configured branch. Run it to confirm you're looking at the right repo and branch and pick a PR to inspect. An empty queue is expected if no PRs target that branch.
   - `conveyor explain 42` shows the PR's current commit, check results, and blockers. Replace `42` with a number from the queue. Run this when you want to know what a particular PR still needs.

5. **Preview the first action when you're ready to enable merges.** After reviewing a PR's exact current commit, authenticate `gh` as the trusted publisher and run `conveyor clear <pr> <full-reviewed-sha>`, replacing both placeholders. A new commit needs fresh review and clearance. Switch back to the worker credential and run `conveyor resume` to grant consent (eight hours by default). Then run `conveyor tick --dry-run`. It previews which PR the worker would act on, if any, without merging or updating a branch. If the preview shows the action you intend to take, run `conveyor tick` to attempt it. Use `conveyor pause` to end consent early.
6. Before scheduling ticks, arrange to fast-forward the clean worker checkout when the base advances. Run `git pull --ff-only origin <base>` on the configured base branch while no tick is running. Conveyor checks the checkout but does not pull it forward.

Read access is sufficient for inspection only when it covers the repository, PRs, checks, Actions and branch protection. Clearance requires the configured publisher identity and permission to create commit statuses. The worker needs permission to merge into the configured base and, if enabled, update PR branches. It must also be able to read the same evidence. GitHub's merge API pins the head SHA but cannot pin the target branch, so use GitHub rules to restrict the worker's merge permission to the configured base. Verify in a disposable repository that required checks apply to the worker and that the worker cannot merge a PR retargeted to another branch. `doctor` checks visible prerequisites. Protect the checkout and its credentials because local operators with write access to the Git common directory can pause or resume the worker.

## Operating boundaries

- `queue`, `explain`, `status`, `doctor`, `report --days 7`, and `tick --dry-run` inspect; `tick` can write. `--json` returns one result on stdout. Use `conveyor --help` for options and exit codes.
- Incomplete evidence can make the next action unknown. Interactive reads have a 15-second and 160-command budget, with up to 200 open PRs and 99 check contexts per PR. Split a PR exceeding the 300-file pinned comparison limit before relying on Conveyor to inspect or act on it.
- Sensitive paths are held for separate approval. The standalone CLI/API does not expose a held-path approval command; do not treat `clear` as that approval. Resolve the change through your established authorized review and merge process, or use a compatible existing integration that supplies approval records.
- Automatic branch updates are off by default. If enabled, an update changes the head and requires fresh clearance. GitHub branch protection remains authoritative.
- An `unknown` write outcome means the response was not confirmed, not that the write failed. Reconcile against GitHub before retrying. See [operator recovery](docs/operator-recovery.md).

See the [API reference](docs/api.md), [agent walkthrough](docs/agent-walkthrough.md), [operator recovery guide](docs/operator-recovery.md), and [contribution guidance](CONTRIBUTING.md). Release terms are in [LICENSE](LICENSE); the package is distributed under the [MIT License](LICENSE).
