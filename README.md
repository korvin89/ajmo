# Ajmo

*Ajmo* ("AY-mo") is Serbian for "let's go".

A VS Code extension for working with several Claude Code agents at once. It
shows every session and tells you when one is waiting for you, opens the code
a session works on, and lets you talk to the agent on the lines of that code
instead of in GitHub's web UI. A companion Claude Code plugin brings two
skills built for this: reviewing a pull request and taking your own task to a
merged one. The skills also work in Ajmo IDE, a not-yet-public fork of
Code - OSS built around agent sessions.

- **Sessions.** A side panel with every Claude Code session, grouped by
  repository, with its status. A counter and a shortcut take you to the next
  one that needs you.
- **Review.** `/ajmo:code-review <pr>` puts the agent's findings on the lines
  of the code in VS Code. You curate them there, add your own comments, and
  only the finished ones go into your pending review on GitHub.
- **Task.** `/ajmo:task <task>` plans, writes the code in a worktree, reviews
  itself and opens a draft PR. You tell the agent what to change on the
  lines, answer reviewers from the same window, and it follows CI to the
  merge.

## Install

You need the `claude` CLI with agent view (`claude agents`), and for the
skills `git`, the GitHub CLI `gh` (logged in) and `jq`.

The extension: download the latest `.vsix` from the
[releases](https://github.com/korvin89/ajmo/releases) and install it:

    code --install-extension ajmo-<version>.vsix

The plugin with the skills:

    claude plugin marketplace add korvin89/ajmo
    claude plugin install ajmo@ajmo

Update it later with `claude plugin marketplace update ajmo` and
`claude plugin update ajmo@ajmo`. To build the extension yourself, see
*Development*.

If VS Code cannot find `claude`, set the full path in `ajmo.claudePath`.

## Sessions

The "Ajmo: Agents" panel in the activity bar. Session data comes only from
`claude agents --json --all`.

- Sessions are grouped by repository. The order is static: repositories by
  name, sessions newest first. A status change never moves a row.
- A row is the session name and a status icon: waiting for you, failed,
  working, done (a filled check until you have seen it), stopped.
- Clicking a session opens a terminal with `claude attach <id>`. The session
  whose tab is active is selected in the list and counts as seen.
- The counter on the panel icon and in the status bar says how many sessions
  need you. Clicking the status bar item, or `Cmd+Alt+A` (`Ctrl+Alt+A`),
  jumps to the next one: waiting first, then failed, then finished and
  unseen.
- "+" in the view title starts a session: pick a repository, type the
  prompt, and the panel runs `claude --bg` there. Typing `/` in the prompt
  suggests your skills.
- "Search & Filter" above the list: a search box and the buttons "All",
  needs attention, working. "Ajmo: Find Session" in the Command Palette jumps
  to a session by name.
- The "…" button on a row (and the context menu): open in a terminal, open
  the code, open the pull request, mark as seen or unseen, copy the id,
  delete. Deleting a session that ran a review or a task offers to remove
  what it left on disk as well.

## Code windows

"Open Code in New Window" on a session opens the folder it works in as a
separate VS Code window: a review's checkout of the PR, a task's worktree,
the session's own worktree, otherwise the repository. Such a window gets a
second panel, "Ajmo: Review", with two views.

**Changes** lists the files changed against the base branch, uncommitted
changes included, as a flat list or a folder tree. A file opens as a diff
whose right side is the real file, so you can jump into unchanged code.

**Comment threads** sit on the lines, in a diff or in a plain file:

- the agent's findings and notes, with a robot icon;
- your comments, written with "+" next to a line. "For Agent" is a question
  or a command for the agent and never leaves your machine. "For Author" (in
  a review) or "For Reviewer" (in a task) is your own comment for GitHub,
  published word for word;
- the PR's threads from GitHub, with their authors' avatars. You can answer
  in them the same way, and the check mark in a thread's title resolves it
  on GitHub.

**Draft** lists every local thread. Its title has three buttons: Sync asks
the agent to read what you wrote and answer; the cloud asks it to put the
finished comments into your pending review on GitHub; the last one clears
the draft. You submit the review on GitHub yourself — the extension and the
skills never do.

## Reviewing a pull request

In a session started from a clone of the PR's repository:

    /ajmo:code-review 1234

1. The skill checks the PR out next to your clone, without touching your
   checkout, reviews it, and puts its findings on the lines. Open the code
   from the session's row.
2. Answer in the threads with "For Agent" — `shorter`, `delete`, `why?`,
   `suggest fix` — and write your own comments with "For Author". Press Sync:
   the agent reads them and answers in the same threads.
3. Press the cloud button, or say `draft` in the session. The findings you
   kept and your own comments go into your pending review; the talk with the
   agent stays local. It can be repeated: only what changed is published.
4. Read the draft on GitHub and submit it.

When the author pushes, the next Sync moves the review to the new commits:
threads follow their lines, findings the push fixed are removed, threads
whose code changed are marked. Say `re-review` to have the agent review what
was pushed since and write under each of your earlier comments whether it was
fixed, left as is, or answered.

## Your own task

    /ajmo:task ABC-123        a tracker key, an issue, your own PR, or plain text

1. The skill reads the task, plans it and waits for your approval.
2. It writes the code in a worktree next to the repository
   (`<repo>.worktrees/<branch>`), never in your checkout, reviews its own diff
   with two independent critics, and opens a draft PR. What the self-review
   did not fix waits on the lines as notes.
3. In the code window, "For Agent" on a line says what to change. Sync makes
   the agent act: it changes the code, commits, pushes, and answers in the
   thread.
4. Reviewers' threads appear in the same window. "For Agent" in one is your
   verdict — `valid`, `valid, but …`, a question, or `answer: …` to have the
   agent write the reply. "For Reviewer" is your own reply. Replies go out
   with the cloud button.
5. `watch` in the session follows CI, conflicts with the base and the merge.
   The agent fixes failed checks and mechanical conflicts; about new comments
   it only tells you.

Only your word changes the code once the PR is open: not a reviewer's
comment and not a bot's. The agent never moves the PR out of draft, merges
or submits a review.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `ajmo.claudePath` | `claude` | CLI command or path |
| `ajmo.launchDirectory` | empty | folder whose repositories are offered for a new session; empty — the workspace folder, or its parent when that folder is a repository |
| `ajmo.pollSeconds` | `3` | polling interval |
| `ajmo.openIn` | `editor` | open the terminal as an editor tab or in the bottom panel |
| `ajmo.notifications` | `true` | notify when a session starts waiting for you or fails |
| `ajmo.notifyOnDone` | `false` | also notify when a session finishes |

## Limitations

- Notifications are VS Code toasts in the focused window; nothing reaches
  you while you are in another application.
- An interactive session (one you run in a terminal or in the Claude Code
  extension chat) is listed but cannot be attached to from the panel. A
  click reveals its chat tab when it has one.
- VS Code forgets terminal tab names on a window reload. The panel restores
  them once on startup, and the tabs flicker briefly while it does.
- The extension changes one VS Code default: `comments.maxHeight` becomes
  `false`, so a long comment is shown in full. This applies to every comment
  in VS Code; set it back to `true` if you prefer the scrolling box.
- A session is linked to its PR, its code and its files through what the
  `ajmo` skills write in `<repo>/.git/ajmo/`. A session started without them
  is linked to a PR only by a number in its name ("pr 123").

## Development

Requires Node.js 22.18 or newer (the tests run TypeScript directly), and
`bash`, `git` and `jq` for the script tests.

    npm ci
    npm run typecheck   # type check
    npm test            # logic and script tests
    npm run smoke       # the built extension against a vscode stub and a fake claude
    npm run package     # build the .vsix

`AGENTS.md` describes the layout and the rules; `docs/` holds what was
learned about the Claude Code CLI and VS Code, the file protocol between the
extension and the skills, the decisions made so far and the roadmap. To debug
in a real VS Code, open the folder and press F5.

## Credits

The thread icons in `media/thread-*.svg` are "comment", "chat-sparkle" and
"robot" from [vscode-codicons](https://github.com/microsoft/vscode-codicons)
by Microsoft, licensed under CC BY 4.0, recoloured.

MIT licensed.
