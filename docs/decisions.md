# Decisions

Made by the user. Do not revisit them unless asked. Only what the code and
the README do not already say is kept here: the choices behind the product,
and the ideas that were tried and rejected, so that they are not proposed
again.

## Product

- Claude Code and VS Code only: no third-party multiplexers or shells, no
  VS Code fork.
- One main VS Code window holds the agents: the panel, session terminals and
  chats. A session's code is read in separate windows opened on its folder;
  several such windows are fine. Rejected: a second folder "slot" in the main
  window (needs a reload and a workspace file, and mixes search results).
- A row is a session. Session state comes only from `claude agents`; the
  skills' files are never a source of status.
- A background session opens in a terminal with `claude attach`, not in the
  Claude Code extension chat.
- The name Ajmo is for the repository, the marketplace and the skills'
  prefix. Inside VS Code the labels stay functional ("Sessions", "Changes",
  "Draft"); only the two panel titles carry the name. Command titles have no
  "Ajmo:" in them: the palette category adds it.
- Icons are monochrome pictograms in the text colour; status is told by
  shape. No mascot and no icons of our own drawing beyond the product icon.
- In-VS Code notifications are enough for now.

## The list

- A native VS Code tree. Do not rewrite it as a webview.
- The order is static. Nothing moves a row and nothing hides a session.
  Rejected: sorting by status, hiding old finished sessions, a "recent" mode.
- A row shows a name and a status icon. Rejected: status text, time, an
  "interactive" mark, a tooltip with the session's last output.
- The active session is marked by row selection only, like the Explorer.
- Row actions sit behind one "…" button, Delete below the only separator.
  Rejected: a Stop action, inline buttons per action.
- Search and filters are a separate view above the list. Rejected: buttons
  in the Sessions title (they jumped), a "done" filter, quick filters by
  repository, an indicator row in the list.
- Rejected: tiles (session terminals side by side). The user comes to a
  session when it calls and does not watch running ones.

## Talking to the agent in the IDE

The user wants to stop curating reviews in GitHub's web UI.

- The conversation with the agent happens on the lines of the code, as
  comment threads. The GitHub pending review is only the outbox: finished
  comments go there on `draft`, and nothing before it.
- Submit happens on GitHub, by the user. Neither the extension nor a skill
  submits a review, changes draft/ready, or merges.
- The agent acts on the user's comments only on a manual sync: the button or
  the word. Rejected: a watching mode that acts on its own; the user found
  it inconvenient in the earlier skills.
- New commits on a PR under review are picked up as part of a sync or a
  draft, and the agent only says that they came. Rejected: a separate
  `update` command, and offering a re-review unasked. `re-review` is a
  command because it costs a full pass.
- No `stop` command. A review or a task ends when its session is deleted in
  the panel, which removes its files.
- Resolving a thread is the one thing the panel writes to GitHub itself, at
  once: a thread's resolved state is not part of a pending review.
- "For Agent" is the primary button of a comment box: it is the frequent and
  the safe action.
- Several threads on one line stay separate. Merging them was offered and
  declined.
- Comments are shown in full, without the inner scroll.

## The skills

- The IDE flow lives in this repository's own plugin, `ajmo`, as forks of
  the user's earlier `korvin89` skills. Those stay untouched: colleagues use
  them without this extension. Both plugins can be installed at once, so
  `ajmo` keeps its files in `<repo>/.git/ajmo/`, never in `code-review/`.
- The skills have the same names as their originals (`code-review`, `task`);
  the plugin prefix tells them apart. They start only on an explicit command.
- The review rubric and the way a diff is collected are the same in content
  as in the original; everything about talking to the user is new.
- A PR checkout is named `<repo>-pr-<n>` and a task worktree after its
  branch, because VS Code names a window after its folder.
- In a task, only the user's word changes code once the PR is open: not a
  reviewer's comment and not a bot's. The verdict on a reviewer's thread is
  given in the IDE, in that thread. Rejected for the IDE flow: `ai:` commands
  written on GitHub, and acting on a bot's thread unasked.
- A task's watcher acts on CI, conflicts and the merge. About new comments
  it only says that they came.
- Deleting a task from the panel removes its worktrees, the local branches
  it created and its folder. Pushed branches and PRs stay: closing a PR is
  the user's call.

## Sessions and tabs

- A new session starts from a popup in the panel: repository, prompt,
  `claude --bg`. Rejected: opening agent view in a tab.
- The repository list is alphabetical, with no "last used first".
- Terminal tab names are short and carry no folder suffix; they are restored
  once on startup, at the cost of a brief flicker.
