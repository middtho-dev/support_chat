# Project workflow

## Source of truth

- GitHub `main` is the canonical branch.
- Before starting any code change, fetch `origin`, switch the local checkout to
  `main`, fast-forward it to `origin/main`, and verify that the worktree is
  clean.
- Create a fresh `agent/<task>` branch from that current `main`. Never reuse a
  branch whose pull request has already been merged.
- Do not merge an older or parallel branch until its diff has been compared
  against the current `main`. Close stale Codex-created pull requests whose
  changes are already integrated or superseded.

## Validation

- Run `npm run check`, `npm test`, and `git diff --check` before publishing.
- If `origin/main` advances while work is in progress, integrate the new
  `origin/main`, inspect the resulting diff, and rerun all validation.
- A GitHub Actions job that did not start because of an account billing lock is
  an infrastructure failure, not a code test result. Local checks must still
  pass before merge. A real CI test failure must be fixed before merge.

## Automatic publishing

- For every completed code change requested by the user, publish it without a
  separate reminder: commit the scoped files, push the fresh branch, create a
  non-draft pull request to `main`, and merge it automatically.
- Before merging, verify the PR base, exact head SHA, changed files, and that it
  contains no superseded or unrelated commits.
- Merge using the expected head SHA so GitHub rejects the operation if the
  branch changes unexpectedly.
- Routine PR creation and merge do not require an additional confirmation from
  the user. Stop only for a genuine safety issue, unrelated local changes, an
  actual failing test, missing authority, or an external blocker.

## Post-merge synchronization

- After merge, fetch `origin`, switch back to local `main`, fast-forward it, and
  verify both the commit SHA and Git tree against `origin/main`.
- Finish each task with the local checkout on a clean, current `main`.
- Report the merged PR URL, final `main` SHA, validation results, and any
  infrastructure-only CI issue.
