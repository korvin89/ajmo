# Roadmap

Ask which one to take next; the order below is the user's priority.

## Built, waiting for the user's check

Tests and the smoke run pass for all of it; what has to be seen in a real
window or a real session is listed here until the user confirms it. Remove a
line once it is confirmed.

- Review: threads carried over to new PR commits (v0.19); `re-review`,
  replies in GitHub threads (v0.20); resolve and the "Post the Draft" button
  (v0.21); `draft` itself after the fix in v0.23 — `publish.sh` did not parse
  in v0.20–0.22.
- Task, all of it (v0.22–0.23): plan to draft PR, the guard hook, the
  `ajmo:critic` agent, comments on the lines, the reviewers' threads with
  "For Reviewer", the watcher for CI and the merge, deleting a task with its
  files. Never run in a real session yet.

The riskiest parts: the guard hook wired through the skill's frontmatter,
the "For Reviewer" button (its condition depends on the thread's context
value), and two background processes in one session (the Sync listener and
the watcher).

## Next: publication

- Fix what the user's check finds; revise the skills' texts after it.
- A public repository as a single initial commit: the local history holds
  internal names and must not be pushed.
- CI: typecheck, tests, the `.vsix` as an artifact.
- The README and `package.json` already point at `github.com/korvin89/ajmo`;
  check the install lines once the repository exists. A screenshot in the
  README. A release with the `.vsix`: the README sends the reader there.
- Decide: the Marketplace, or only a `.vsix` in the releases.

## Later

### GitHub inbox

What waits for the user on GitHub and has no session yet.

- A list in the agents panel: PRs where a review is requested, mentions, new
  comments and failed CI on the user's own PRs, read through `gh`.
- "Start review" and "Start task" on a row run a background session with the
  skill.
- A PR that already has a live session marks that session instead of being
  listed twice.
- Mark a session that has an open PR but a stopped process: nobody follows
  that PR. First confirm that a watcher really dies with its session.

Open questions: how often to poll, and what counts as read.

### System notifications (postponed by the user)

Today notifications are VS Code toasts in the focused window only.

- Notifications visible while the user is in the browser. The method is not
  chosen: on macOS `osascript` has no click action, `terminal-notifier` has
  one but must be installed. Ask.
- The session name and the agent's actual question in the text.
- A few seconds of delay, so a quickly answered prompt does not pop up;
  several events in a short time merged into one.
- One reminder when a session waits longer than a threshold.
- A quiet mode in the status bar.
- One notification per event across several windows.

## Only if the user asks

- A "Re-review" button in the Draft view.
- One code window that follows the active session, instead of a window per
  worktree.
- Opening a background session in the Claude Code extension chat.
- Answering a permission prompt from a notification.
- Comments of a task window read by the older `korvin89:task` skill: that
  plugin is not changed from here.
