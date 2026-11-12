# Contributing

`merge-conveyor` is source-available (see `LICENSE`), and **outside pull requests are not accepted yet**.
The maintainer needs a contributor agreement in place before merging code from anyone else, so the
project can still be relicensed. Until that exists, a pull request from outside will be closed unread.

What helps now:

- **Bug reports and questions:** open an issue at <https://github.com/bretperry/conveyor/issues>. Say what you ran,
  what you expected, and what happened.
- **Security problems:** do not open an issue. Follow `SECURITY.md`.
- **Ideas:** open an issue first. A good idea may be built by the maintainer.

When a contributor agreement exists, this file will say how to sign it.

Maintainers: the seeded checkout enables `.githooks/pre-push`. In a new clone, enable it with
`git config core.hooksPath .githooks`. Install Node.js and gitleaks, and export `HARNESS_DENYLIST`
locally before pushing. `node .release/check.mjs` runs the same gate by hand. Never commit the list.
Set `HARNESS_DENYLIST` as a repository Actions **secret**, so main, same-repo PRs and release tags
run every check. Fork PRs run the other checks and explicitly report that private terms were skipped.

Pull requests from forks run the fork's own copy of the gate and workflow, so a green gate on a fork PR is
not evidence: the gate that counts is the run on `main` after the merge. Read the diff, especially `.release/`,
`.github/` and `.githooks/`: changes to those paths need the owner's review. Dependabot PRs come from the same repo but receive no
Actions secret, so the full gate fails with a blank term list. Rerun or merge them after the gate passes on `main`,
or add `HARNESS_DENYLIST` as a Dependabot secret too.

For maintainers working on the package, use Node.js 22 or later and run `npm test` from the repository root. Document user-visible changes and keep examples aligned with the CLI help and `src/index.d.mts`. Report security issues using the process above rather than including credentials or private repository data in a report.
