# Conveyor

Conveyor inspects a GitHub pull request queue and runs at most one merge or branch update per tick. It is a local Node.js CLI and library; you supply a persistent, trusted checkout and a scheduler. It supports one active worker per repository, not a hosted service or a multi-worker queue.

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
4. Configure GitHub branch protection with strict required checks that apply to the worker identity. The worker must have no bypass rights. A successful GitHub Actions push workflow must exist for the current base tip; PR checks may be GitHub Actions or external checks reported to GitHub. Configure an allowed merge method. Run:

   ```sh
   conveyor doctor
   conveyor queue
   conveyor explain 42
   conveyor tick --dry-run
   ```

5. After reviewing the full current head SHA for PR 42, authenticate `gh` as the configured trusted publisher and run `conveyor clear 42 <full-reviewed-sha>`. Clearance is scoped to that SHA, PR, and configured base. A new head needs a new review and clearance. Use the worker credential in the trusted checkout to run `conveyor resume` and `conveyor tick`. Resume grants time-limited consent (eight hours by default). The worker starts paused and stops acting after consent expires. Use `conveyor pause` to stop it sooner. Schedule ticks after you have run and understood the preview and a manual tick.

Read access is sufficient for inspection only when it covers the repository, PRs, checks, Actions and branch protection. Clearance requires the configured publisher identity and permission to create commit statuses. The worker needs permission to merge PRs and, if enabled, update branches; it must also be able to read the same evidence. Local operators who can write the common Git directory can pause or resume the worker: protect that checkout and its credentials. `doctor` checks visible prerequisites but does not prove the worker lacks bypass rights; verify that in GitHub settings and in a disposable repository.

## Operating boundaries

- `queue`, `explain`, `status`, `doctor`, `report --days 7`, and `tick --dry-run` inspect; `tick` can write. `--json` returns one result on stdout. Use `conveyor --help` for options and exit codes.
- Incomplete evidence can make the next action unknown. Interactive reads have a 15-second and 160-command budget, with up to 200 open PRs and 99 check contexts per PR. Split a PR exceeding the 300-file pinned comparison limit before relying on Conveyor to inspect or act on it.
- Sensitive paths are held for separate approval. The standalone CLI/API does not expose a held-path approval command; do not treat `clear` as that approval. Resolve the change through your established authorized review and merge process, or use a compatible existing integration that supplies approval records.
- Automatic branch updates are off by default. If enabled, an update changes the head and requires fresh clearance. GitHub branch protection remains authoritative.
- An `unknown` write outcome means the response was not confirmed, not that the write failed. Reconcile against GitHub before retrying. See [operator recovery](docs/operator-recovery.md).

See the [API reference](docs/api.md), [agent walkthrough](docs/agent-walkthrough.md), [operator recovery guide](docs/operator-recovery.md), and [contribution guidance](CONTRIBUTING.md). Release terms are in [LICENSE](LICENSE); the package is source-available under FSL-1.1-MIT.
