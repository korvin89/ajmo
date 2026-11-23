# Branches, the changelog and releases

`main` is what users have: it always equals the latest release. The skills
plugin is installed straight from `main`, so nothing unfinished may sit
there. Work for the next version collects on the branch `next`, as many
commits as it takes, and reaches `main` only as a release, on the user's
word.

## The branch `next`

- There is one, always under that name. It is cut from `main` when the first
  change after a release starts, and deleted by the merge that releases it.
- Opening it:
  1. `git switch -c next main`.
  2. Set the version to the next patch (0.24.7 → 0.24.8), see below, in the
     first commit: every build from the branch then differs from the
     installed release.
  3. `git push -u origin next`.
- Never commit to `main` directly. If you find yourself on `main` with a
  change to make, switch to `next` first, opening it if it is not there.

## The version

The version on `next` is always the one the branch would be released under
if it were released now. It is counted from the latest release, the version
on `main`, by what `## [Unreleased]` holds:

| `[Unreleased]` holds                 | Version                       |
| ------------------------------------ | ----------------------------- |
| nothing, or `### Fixed` only         | next patch: 0.24.7 → 0.24.8   |
| anything under `### Added` or `### Changed` | next minor: 0.24.7 → 0.25.0 |
| a "**Breaking:**" line               | ask the user: a major is theirs to name |

So the first feature after a fix raises 0.24.8 to 0.25.0, in the same commit
as its changelog line; the second feature changes nothing. The version only
goes up within a branch.

Set it in both places at once:

    npm version <version> --no-git-tag-version   # package.json, package-lock.json
    # and "version" in plugin/.claude-plugin/plugin.json

## With every change

- Commit to `next` and push it; CI runs on every push.
- Add a line to `## [Unreleased]` in `CHANGELOG.md` when the change is
  something a user of the extension or of the skills can notice. Nothing for
  refactoring, tests, internal docs or this file.
- Write it for that user, in English, as what they can now do or what no
  longer goes wrong — not as what was done to the code. One line; start with
  the place ("Review: …", "Task: …", "Sessions: …") when it helps.
- Put it under one of three headings, created when first needed:
  `### Added` (something new), `### Changed` (the same thing works
  differently), `### Fixed` (a bug). A change that breaks what a user relied
  on goes under `### Changed` and starts with "**Breaking:**".
- If the line moves the version by the table above, raise it in the same
  commit.
- No tag. The `.vsix` built on the branch is for the user's own check.

## A release, on the user's word

1. **Check the ground.** On `next`, a clean tree, pushed, CI green on its
   head (`gh run list --branch next --limit 1`). An empty `[Unreleased]`
   means there is nothing a user would notice: say so and ask whether to
   release anyway.
2. **Name the version** to the user: the one in `package.json`, checked
   against the table above and equal in `plugin.json`.
3. **Close the changelog.** Rename `## [Unreleased]` to
   `## [<version>] — <YYYY-MM-DD>`, put a new empty `## [Unreleased]` above
   it, update the two links at the bottom.
4. **Run everything:** `npm run typecheck`, `npm test`, `npm run smoke`,
   `npm run package`, `claude plugin validate plugin`.
5. **Commit** as `Changelog for v<version>` and push the branch.
6. **Open the pull request** into `main`, titled `Release v<version>`, with
   that version's changelog section as its body (`gh pr create`). Wait for
   its checks.
7. **Merge it with a merge commit** (`gh pr merge --merge --delete-branch`):
   `main` then reads one merge per release. Never squash: the commits are
   the history.
8. **Tag the merge:** `git switch main && git pull`, `git tag v<version>`,
   push that one tag by name. Never `git push --tags`. Delete the local
   `next`; the next change opens a new one.
9. **The tag does the rest:** `.github/workflows/release.yml` checks that the
   tag, both version files and the changelog agree, runs the checks, builds
   the `.vsix` and publishes the GitHub release with the changelog section
   as its notes. Watch the run (`gh run watch`) and give the user the link.
   If it fails, fix it on a new `next` and release that as the next patch;
   never move or reuse a tag.

## A fix that cannot wait

When `next` holds unfinished work and `main` needs a fix now: cut `hotfix`
from `main`, set the next patch version, fix with a `### Fixed` line, and
release it exactly as above, with `hotfix` in place of `next`. Then bring
`next` up to date: `git merge main` there, keep both sides of
`CHANGELOG.md` (the released section below `[Unreleased]`), and count the
version again from the new release — 0.24.8 on `next` becomes 0.24.9, while
0.25.0 stays.

The Marketplace is not part of this yet: the `.vsix` in the release is how
the extension is installed.
