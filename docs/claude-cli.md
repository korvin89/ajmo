# Claude Code facts

Claude Code changes fast. Re-check a fact against the docs before building on
it: https://code.claude.com/docs/en/agent-view,
https://code.claude.com/docs/en/hooks, https://code.claude.com/docs/en/vs-code.

## `claude agents --json --all`

Observed on CLI 2.1.321 (2026-11-21). The same values are fixtures in
`test/model.test.ts`.

```json
{ "id": "c0774b9d", "cwd": "/Users/…/charts", "kind": "background", "startedAt": 1795195221546,
  "sessionId": "c0774b9d-3975-…", "name": "gravity-charts-pr-853", "state": "done" }
{ "pid": 50716, "id": "00075973", "kind": "background", "status": "waiting",
  "waitingFor": "input needed", "state": "blocked", … }
{ "pid": 27622, "kind": "interactive", "sessionId": "af4e5508-…", "status": "idle", … }
```

- `pid` and `status` exist only while the session process is alive.
- Working: `status: "busy"`, `state: "working"`. `status: "busy"` with
  `state: "done"` is a session whose agent has finished its turn while a
  background shell it started still runs: observed on 2026-11-23 on a review
  session that had been sitting on `threads.sh wait` for half an hour. So
  `state` is the agent's turn and `status` the process; the panel shows such
  a session as done. An interactive session has no `state`, so there the two
  cases cannot be told apart. Waiting: `status: "waiting"`,
  `state: "blocked"`, plus `waitingFor`.
- `state: "done"` means "ready for the next message", not "the user saw it".
- An interactive session has `status` and `pid` but no `id` and no `state`,
  so `claude attach` cannot open it.
- A Claude Code extension chat session is also `kind: "interactive"`. Its
  process descends from the window's extension host. It is listed only while
  that process runs: after a window reload, once its tab is opened.
- There is no last-activity time, only `startedAt`.
- `cwd` is usually the repository's main checkout. It can also be Claude
  Code's own worktree, `<repo>/.claude/worktrees/<name>`.
- The PR number appears only inside the session name.

Documented but not observed: `waitingFor` values `permission prompt`,
`sandbox request`, `worker request`, `dialog open`.

## Starting a session

- `claude --bg "<prompt>"` starts a background session in the current
  directory and prints its id. The panel runs it without a TTY as
  `claude --bg -- <prompt>` and takes the id from the output (confirmed by
  the user).
- From the docs: a background session moves into a worktree under
  `.claude/worktrees/` before editing files, unless `worktree.bgIsolation` is
  `"none"`.
- The repositories offered for a new session follow agent view's `@` rule
  from the docs: git repositories one level below the launch directory, plus
  any directory that already has a session.

## Skills

The CLI has no command that lists slash commands, so the panel reads the
files (layout observed 2026-11-21, not documented as stable):

- `claude plugin list --json` gives `id` (`name@marketplace`), `enabled` and
  `installPath` per plugin. Plugin skills live in `<installPath>/skills/**/SKILL.md`
  and are invoked as `/<plugin>:<skill>`.
- Personal skills: `~/.claude/skills/<name>/SKILL.md`; repository skills:
  `<repo>/.claude/skills/<name>/SKILL.md`; plain commands: `commands/*.md`
  next to either. Invoked as `/<name>`.
- The frontmatter has `name`, `description` (often a `>-` block) and
  optionally `user-invocable: false`.
- Built-in commands are not in any file and are not suggested. A plugin may
  ship more SKILL.md files than Claude Code itself offers; the panel lists
  them all.

## Plugins

- A repository with `.claude-plugin/marketplace.json` is a marketplace;
  `claude plugin marketplace add <path>` then `claude plugin install
  <plugin>@<marketplace>` installs from a local folder.
  `claude plugin validate <path>` checks a marketplace or a plugin folder.
- A skill's Bash commands see `CLAUDE_CODE_SESSION_ID` (taken from the
  `korvin89:task` scripts, which rely on it); the `ajmo` review skill writes
  it to `<scratch>/session`.
- `disable-model-invocation: true` in a skill's frontmatter makes it run only
  on an explicit `/plugin:skill` command.

## Commands

From `claude --help` on 2.1.321:

- `claude attach <id|name>` opens a background session in the terminal and
  revives a stopped one (the user confirmed the revive). It runs as a child
  of the terminal's shell, which is how the panel maps terminals to sessions.
- `claude rm <id>` deletes a session and, when that is safe, its worktree
  (the Delete action; confirmed by the user).
- `claude logs <id>` answers only while the session process is alive ("job
  not found" otherwise) and prints the whole scrollback as a terminal dump
  with cursor-column escapes instead of spaces. Unused by the panel.
- Also exist: `claude stop <id>`, `claude respawn [id]`,
  `claude agents --cwd <path>` (filters the list).
- No command sends text to a running background session.
  `claude --bg --resume <session-id> "<text>"` continues a stopped session
  and starts a copy of a running one. Never run by the panel.

From the docs, unverified:

- An idle detached session's process stops after about an hour unless pinned.
- The `Notification` hook (`agent_needs_input`, `agent_completed`) fires only
  while agent view is open.

## Claude Code VS Code extension

- `claude-vscode.primaryEditor.open(<sessionId>)` reveals the session's chat
  tab if it is open and opens one otherwise. Internal command, read from the
  2.1.325 bundle; the user confirmed it reveals the tab. It also backs
  `vscode://anthropic.claude-code/open?session=<id>`.
- A chat tab's title is not the session name from `claude agents`, and the
  tab does not expose its session id.

## The user's skills

Plugin `korvin89` (`korvin89/claude-skills`): `task` drives a task to a
merged PR, `code-review` runs a review as a GitHub draft review.

- Task state: `<git-common-dir>/code-review/task-<key>/` with `task.json`
  (units with `worktree`, `pr`, `branch`), `ledger.json`, `lock`
  (`<session id> <claude pid> <epoch>`), `watch-task.pid`.
- Task worktrees: `<repo parent>/<repo>.worktrees/<branch>`.
- A PR review keeps the PR head checkout in `code-review/pr-<n>/head/`, the
  PR link in `pr-<n>/pr.url`, and a `watch.pid`.
- `task.json` `units[].pr` is the unit's PR URL or null. The panel reads
  `lock`, `task.json` and `pr.url` to offer "Open Pull Request" (observed
  2026-11-21; the formats belong to the user's skills).
- `korvin89`'s `skills/cleanup/scripts/cleanup.sh <pr-N | task-key>` removes
  a review's or a task's files after its own checks; with warnings it prints
  `CONFIRM <code>` and `- warning` lines and exits 10, and removes only when
  rerun with `--yes=<code>`. The panel calls it from "Delete Session and
  Files", finding the script through `claude plugin list --json`. Never run
  from here.
- Following a PR runs inside the session process, so a stopped session
  probably has a dead watcher. Unverified: no `watch.pid` existed when
  checked. `lock` files do keep the pid of a stopped session process.
