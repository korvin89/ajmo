# Review threads: the contract between the panel and the skills

Both sides exist: the panel (`src/protocol.ts`, `src/review.ts`) and the
`ajmo` plugin — `threads.sh`, `publish.sh` and `github.sh` in
`plugin/skills/code-review/scripts/`, used by both of its skills.
`test/threads-script.test.ts` runs the scripts and checks that the panel
reads the same threads, and the publish plan. The `korvin89` skills do not
use these files. Change the format here first, then both sides and the test.

## Roles

- The panel draws threads in the editor and lets the user write. It reads
  the PR's threads from GitHub, and resolves or unresolves one when the user
  clicks; it publishes nothing and never edits what the agent wrote.
- The skill (`code-review` or `task`) reads what the user wrote when the user
  asks for a sync, answers in the same threads, and is the only one that
  writes to the GitHub pending review.
- GitHub's pending review is the outbox. Submit happens on GitHub.

## Roles of the user

The scratch folder tells the role:

- `pr-<n>` — reviewer (`code-review`). The comment box offers "For Author"
  (`to: "github"`) and "For Agent" (`to: "agent"`).
- `task-<key>` — author (`task`). The comment box offers "For Agent": the
  user tells the agent what to change in its own work. In a thread that
  lives on GitHub it also offers "For Reviewer" (`to: "github"`), the user's
  reply in that thread.

## Where

The skill's scratch folder of the worktree the window is open on:

- a review by the `ajmo` plugin: `<repo>/.git/ajmo/pr-<n>/`. The window is
  on the PR checkout inside it, `<repo>-pr-<n>/`, named so that the window
  title says what it is; the `checkout` file holds that folder's name (a
  review made before v0.20 has none and uses `head/`). The folder also holds
  `pr.url`, `session` — the id of the Claude Code session running the review,
  by which the panel finds the session's review — and `config.json`, the
  skill's own record of the review settings;
- a review by `korvin89:code-review`: `<repo>/.git/code-review/pr-<n>/`;
- a task: `<repo>/.git/ajmo/task-<key>/` (the `ajmo` plugin) or
  `<repo>/.git/code-review/task-<key>/` (`korvin89:task`), found by the unit
  whose `worktree` in `task.json` is the window's folder. `ajmo:task` reads
  the threads; `korvin89:task` does not. A task's units share the folder, so
  a thread there names its worktree (`root`).

A worktree with neither has no threads: there is nobody to read them.

## Files

Two files, one writer each, so the two sides never write the same file.

### `inbox.jsonl` — appended by the panel

One JSON object per line, never rewritten.

```json
{"type":"comment","id":"c-…","thread":"t-…","to":"agent","body":"shorter","at":"2026-11-22T10:00:00.000Z"}
{"type":"comment","id":"c-…","thread":"t-…","to":"github","body":"Rename this.","at":"…","anchor":{"path":"src/a.ts","line":7,"side":"RIGHT"}}
{"type":"edit","comment":"c-…","body":"Rename this, please."}
{"type":"delete","comment":"c-…"}
{"type":"drop","thread":"t-…"}
```

- `to: "agent"` — a question or a command for the agent ("For Agent").
- `to: "github"` — goes into the user's GitHub pending review as written:
  a review comment for the PR author ("For Author", reviewer role).
- `anchor` is present when the comment starts a new thread. `line` is
  1-based; `side` is `LEFT` for the base file, `RIGHT` for the worktree file.
  In a task window it also has `root`, the window's folder; the skill copies
  it to the thread, and a window shows the threads whose `root` is its folder
  or absent.
- `github: {"thread": "<node id>"}` comes with `anchor` when the comment is
  the first local one in a thread that lives on GitHub. The thread's id is
  then `gh:<node id>`. `to: "github"` there is a reply in that thread, and
  `to: "agent"` a word to the agent about it. The panel sends both again when
  the user writes in such a thread after its local record was dropped.
- `edit` and `delete` change one of the user's own comments, whether or not
  the skill has already folded it into `threads.json`. They never refer to
  the agent's comments.
- `drop` removes a whole thread, whoever started it ("Clear Draft" drops
  every thread). The skill sets the thread to `dropped`; if it was already in
  the GitHub draft, it has to be removed from there on the next `draft`.

### `threads.json` — written by the skill

```json
{
  "version": 1,
  "cursor": 3,
  "threads": [
    { "id": "t-…", "path": "src/a.ts", "line": 10, "side": "RIGHT", "state": "open",
      "comments": [
        { "id": "a-…", "author": "agent", "kind": "finding", "body": "🟠 **should-fix** — …", "at": "…" },
        { "id": "c-…", "author": "user", "to": "agent", "body": "why?", "at": "…" }
      ] }
  ]
}
```

- `head` (top level) — the commit of the review worktree that every
  thread's `line` refers to. `threads.sh rebase` moves the lines to a newer
  commit and updates it.
- `reviewed` (top level) — the commit up to which the code has been reviewed;
  `re-review` looks at what was pushed after it. The panel does not read it.
- `github` on a thread — where it is on GitHub: `thread` is the node id,
  `comments` maps a local comment id to its published copy (`id`, `body`).
  The skill sets it when it publishes a thread; a `gh:` thread has it from
  the start. The panel uses it to draw a thread once, with its local and its
  GitHub comments merged by time, a published local comment standing in for
  its copy.
- `outdated: true` on a thread — the code under it changed in a push; `line`
  is where it was carried to. The panel flags such threads; the skill clears
  the mark with `threads.sh place` once it has looked again.
- `cursor` — how many valid `inbox.jsonl` events the skill has folded into
  `threads`. Torn or malformed lines are skipped by both sides and do not
  count. The panel shows `threads` plus the inbox lines after `cursor`,
  marked "not synced".
- `state`: `open` — being discussed; `published` — in the GitHub draft;
  `dropped` — deleted, not shown.
- An agent comment has a `kind`: `finding` is meant for the other side — the
  PR author in a review, a reviewer in a task — and is what `draft`
  publishes; `reply` is talk with the user and is never published. In a task
  the agent's own notes on the lines are `reply`.
- `acked` on a thread is the id of the user's comment the agent handled
  without replying; the thread waits for the agent when its last comment is
  the user's, `to: "agent"`, and is not the acked one.
- Write the file atomically (write a temp file, rename).

## Asking for a sync from the IDE

- The skill keeps one listener running in the session (`threads.sh wait`). It
  writes its pid to `wait.pid` and removes the file when it ends.
- The panel's Sync button checks that the pid in `wait.pid` is alive and then
  creates `sync.request`. The listener sees the file, deletes it and ends
  with `SYNC`, which wakes the agent; the agent runs a pass and starts the
  listener again.
- The file's first word says what is asked: `sync`, or `draft` from the
  "Post the Draft to GitHub" button, for which the listener ends with `DRAFT`
  and the agent publishes. Anything else counts as a sync.
- With no live listener the panel creates nothing and tells the user to say
  `sync` in the session's terminal.

## What `sync` does in the skill

1. Read `inbox.jsonl` from line `cursor`.
2. Fold each line into `threads`: add the user's comments, apply edits,
   deletes and drops. An edited or deleted comment that already reached the GitHub draft
   has to be updated there too.
3. Act on `to: "agent"` comments and answer in the same thread.
4. Advance `cursor`, write `threads.json`.

## What `draft` does in the skill

A separate command; `sync` never touches GitHub. Implemented by
`publish.sh`; its header is the full description.

1. Run the `sync` steps first, so nothing the user wrote is missed.
2. For every thread, publish its publishable comments — the agent's
   `kind: "finding"` comments (with the `🤖 **AI generated**` marker) and the
   user's `to: "github"` comments (word for word) — into the user's pending
   review: the first one starts a thread on GitHub, the rest are replies in
   it. Talk with the agent is never published.
3. Remember what was published in the thread:

   ```json
   "github": { "thread": "<GitHub thread id>",
               "comments": { "<local comment id>": { "id": "<GitHub comment id>", "body": "<as published>" } } }
   ```

   and set its state to `published`. The next `draft` publishes only the
   difference: new comments, edits, deletions, dropped threads.
4. A comment already submitted on GitHub is never edited or deleted.

The panel reads `github` to draw a published thread once, its local and its
GitHub comments together.

Submit stays on GitHub.

## Not covered

- Carrying over the user's inbox comments that were written before a push
  but not synced: the skill folds the inbox before it moves the head, so this
  only matters if the worktree is moved by hand.
