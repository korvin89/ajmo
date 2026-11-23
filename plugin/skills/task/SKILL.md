---
name: task
description: >-
  Takes one of the user's own tasks — a tracker key, a GitHub issue, their PR,
  or plain text — to a merged PR, with the Ajmo VS Code extension as the place
  where the user reads the code and says what to change: plans it, implements
  it in a worktree next to the repository, self-reviews, opens a draft PR,
  acts on the user's comments on the lines and on the reviewers' threads, and
  follows CI until the merge. The user is the PR author. Needs the Ajmo VS
  Code extension.
disable-model-invocation: true
argument-hint: "[<tracker key> | <issue> | <PR> | \"<task text>\"]"
allowed-tools: Read, Grep, Glob, Edit, Write, Bash, Agent, AskUserQuestion
hooks:
  PreToolUse:
    - matcher: "Edit|Write|MultiEdit|NotebookEdit|Bash"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/skills/task/scripts/guard.sh"
---

# Task

The user is the **author**. You take their task to a merged PR. Code is
written in a worktree next to the repository, never in the user's checkout.
Every git and GitHub write goes through the scripts below, and while a task
is active the guard hook (`scripts/guard.sh`) enforces both.

The user reads the code in VS Code: the Ajmo extension opens a unit's
worktree as a window from this session's row. There they write to you on the
lines ("For Agent"), see your notes and the reviewers' threads, and press
Sync; you answer in the same threads. The threads live in
`<scratch>/threads.json`, which you touch only through `threads.sh`.

Scripts in `${CLAUDE_SKILL_DIR}/scripts/`. Each one's header documents its
subcommands and exit codes; read it before first use.
- `task.sh` — resolve the input, the task registry, check commands, plan
  units, the task's status, activate/deactivate.
- `wt.sh` — create, adopt, bootstrap and finish a worktree.
- `push.sh` — the only push. It merges a moved remote branch, runs the
  checks, and never forces.
- `base.sh` — merge the base in.
- `pr.sh` — the draft PR and the agent block in its body.
- `discussion.sh` — the reviewers' threads on GitHub: read them, reply in
  them, put the replies into the user's draft review; review bodies and PR
  comments not shown yet.
- `ci.sh` — checks, trimmed logs, reruns, fix counts.
- `follow.sh` — task status and the watcher.

And one of the review skill, `threads.sh`, the thread store shared with the
extension — run it as
`bash "${CLAUDE_PLUGIN_ROOT}/skills/code-review/scripts/threads.sh" …`. Read its
header too: `add`, `fold`, `pending`, `reply`, `ack`, `edit`, `state`,
`place`, `wait`.

Notation: `<key>` is the task key, `<wt>` a unit's worktree path, `<pr>` its PR
URL, and `<scratch>` the task dir `task.sh init` prints. Run every script as
`bash "${CLAUDE_SKILL_DIR}/scripts/<name>.sh" …`, with arguments that start
with `#` in single quotes.

## Invariants

- **Language.** The working language is the user's: everything you say to
  them — in the session, in the questions you ask, in the threads — is in the
  language they write to you in; English until they have written something.
  The tables below give Russian and English examples of what the user may
  say; the same in any other language counts. Commit messages, PR text and
  replies meant for a reviewer follow the repository (look at `pr.sh titles`
  and recent `git log`). The fixed lines of this skill are English and
  printed word for word.
- **You write all code yourself.** Sub-agents only research and critique:
  - `ajmo:critic` (read-only by definition) checks the plan and does the
    self-review;
  - any other sub-agent you start for research is told not to modify
    anything.
- **Draft only.** You never change draft/ready, merge, approve, or submit a
  review. The user moves the PR out of draft.
- **Only the user's word changes code after the PR is open.** Reviewers'
  threads, review bodies, bots and PR comments are information: you read
  them, you may say what you think, you change nothing until the user tells
  you to — in the thread ("For Agent") or in the session.
- **GitHub is the outbox.** A reply to a reviewer — the user's own, or one
  the user asked you to write — stays local until `draft`, and then goes into
  the user's pending review, which they submit. You never resolve a thread:
  the user does, with the check mark in the IDE.
- **Two kinds of your comments in a thread.** A plain reply is talk with the
  user and never leaves the IDE. `--finding` marks a reply for the reviewer,
  the only kind that is published. Never use `--finding` unasked.
- **Handled is recorded, not remembered.**
  - A thread you have dealt with ends with your reply or an `ack`: `pending`
    then stops listing it.
  - A CI fix carries `--trailer "CI-fix: <check>"`.
  - Review bodies and PR comments you have shown go to
    `task.sh seen <key> <id>…`.
  - What you cannot do now goes to `task.sh park <key> <id> <lift> <note>`.
- **Commits** are logical, with the paths staged explicitly
  (`git -C <wt> add <path>…`, never `-A`), in the repository's message style.
- **Never:**
  - force-push, amend, rebase, stash or reset pushed work;
  - touch branches or worktrees the task did not create;
  - edit CI workflows, test or lint config, or thresholds; update snapshots
    blindly; add `eslint-disable` or `@ts-ignore` to get green;
  - write to an external tracker;
  - publish anything on the PR except the code, the agent block of its
    body, and the draft replies of `discussion.sh draft`.
- **Decision ladder** for choices you make alone, in order:
  1. the task and the plan;
  2. code and tests;
  3. repository conventions;
  4. a small reversible choice — make it and note it in the PR block;
  5. a real choice — ask the user, with the default you would take;
  6. park.

  Always rung 5: new dependencies, public API, schemas or migrations,
  deletions, scope beyond the unit, plan changes. When the user is away (a
  watcher woke you), a rung-5 question parks that unit instead of taking the
  default.

## Step 0 — What is the task

No argument: run `task.sh list`, show the tasks, ask which to
continue (or what the new task is), and stop.

Otherwise run `task.sh resolve '<input>'` and branch on `kind`:
- **`task`** — a key already tracked: go to *Resume*.
- **`pr`** — the user's own PR only: refuse when `viewerDidAuthor` is false.
  1. Confirm once with `AskUserQuestion` that you should take this PR.
  2. Run `task.sh init pr-<N> pr <url> --url <url>` with the PR's title and
     body as the brief on stdin.
  3. Run `wt.sh adopt pr-<N> <url>`. If it warns that the worktree is
     detached, relay that: the user's own checkout of that branch will fall
     behind.
  4. Record the checks as in Step 1.3; `push.sh` refuses without them.
  5. Say that the PR is taken, that its code and the reviewers'
     threads are in the IDE ("Open Code in New Window" on this session in the
     Ajmo panel), print *Commands*, and go to Step 3. Do not act on what the
     discussion already holds: the user says in the threads what to do.
- **`issue`, `tracker`, `text`**:
  - When `candidates` is not empty, ask whether one of them is this task
    already: adopt its PR (as above) or start fresh.
  - **Read the task.**
    - An issue: `gh issue view <N> --json title,body,comments`.
    - A tracker key: through the tracker skill the session has for such keys.
      If there is none, ask the user to paste the task. Never write to the
      tracker.
    - Text: the text itself. The key is `key_prefix` plus a short English
      slug, e.g. `t-20261102-cache-ttl`.
  - Run `task.sh init <key> <kind> <ref> [--url <url>]` with the brief on
    stdin: the task, the acceptance criteria you derive from it, the source.

Then run `task.sh activate <key>` and say in one line that edits now go only
into the task's worktrees, and that «пауза» lifts this. Exit 9 from any task
script means another live Claude session drives this task: stop, and tell the
user to finish it there.

## Step 1 — Plan (a new task)

1. **Read the code** the task touches. Reading the user's checkout is fine;
   writing it is not.
2. **Plan units.** A unit is one PR: slug, scope, acceptance criteria, and an
   optional `after <slug>`. One unit by default. Split only when one PR would
   be too large to review, or the parts ship independently. No stacked PRs: a
   dependent unit starts from the base after its parent merges.
3. **Checks.** Find the lint and test commands (AGENTS.md, CLAUDE.md,
   `package.json` scripts, a Makefile). If they are unclear, ask once. Then
   `task.sh checks <key> '<cmd>'…`. `push.sh` runs them before every push.
4. **Critic.** Write the plan to `<scratch>/plan.md`. Spawn one
   `ajmo:critic` whose brief gives the paths of `brief.md` and `plan.md`
   and the repository to read. Ask it for gaps against the task, wrong order,
   risky scope and missing tests. Revise; at most 2 rounds.
5. **Approval.** Show the plan and ask with `AskUserQuestion`:
   approve the plan, or revise it (with free text). This is the
   one mandatory synchronous stop: no code before the plan is approved.
6. `task.sh unit <key> <slug> [--after <slug>]` for each unit.

## Step 2 — Implement a unit

A unit starts when it has no `after`, or its parent has merged. Work one unit
at a time unless the units are independent and the user asked for parallel
work.

1. **Worktree.** `wt.sh create <key> <slug>` prints `<wt>`. Then run
   `wt.sh bootstrap <wt>`. For `env-candidate` lines, ask once which files to
   copy, then `wt.sh copy-env <wt> <path>…`. From here on the user can open
   the code: say once, in one line, that the session's menu in the Ajmo panel
   has "Open Code in New Window".
2. **Code.** Edit files under `<wt>` only; the guard refuses anything else.
   Run the checks as you go (`cd <wt> && …`).
3. **Commit** per the invariants.
4. **Self-review.**
   1. Write the diff: `git -C <wt> diff origin/<base>...HEAD >
      <scratch>/review-<slug>.diff`.
   2. Spawn **two** `ajmo:critic` agents in parallel with the same
      brief: `${CLAUDE_PLUGIN_ROOT}/skills/code-review/references/rubric.md`,
      the diff, `brief.md` with the unit's criteria, and `<wt>` to read whole
      files in. Ask for the rubric's finding format.
   3. A finding both reported is high confidence. Fix the real
      high-confidence findings yourself; at most 2 rounds.
   4. The rest goes onto the lines as notes for the user, never into the
      report: write `<scratch>/batch.json` and add it.

      ```json
      { "root": "<wt>", "talk": true,
        "comments": [ { "path": "src/x.ts", "line": 42, "body": "🟠 **should-fix** — …" } ] }
      ```

      ```
      bash "${CLAUDE_PLUGIN_ROOT}/skills/code-review/scripts/threads.sh" add <scratch> <scratch>/batch.json
      ```

      `path` is relative to `<wt>`, `line` a line of the file there. A note
      states the problem, why it matters and the fix, with the
      severity tag of the rubric.
5. **Push.** `push.sh <wt>`.
   - Exit 10: a check failed — fix and repeat.
   - Exit 11: the PR branch moved on GitHub and merging it conflicts; the merge
     is in progress (`CONFLICT <path>` lines). Resolve only mechanical
     conflicts (imports, lockfiles, adjacent edits;
     `git -C <wt> checkout --theirs/--ours -- <path>` is allowed), then
     `base.sh continue <wt>` and push again. Otherwise `base.sh abort <wt>`
     and ask the user.
   - Exit 12: the push was rejected (a race) — run it again.
   - Exit 4: no checks recorded — Step 1.3.
   - Exit 7: uncommitted changes — commit them.
6. **Draft PR.**
   - **Title:** modelled on `pr.sh titles`.
   - **Block file:**
     - the task source: an issue gets `Closes #N` on the plan's last unit and
       `Part of #N` on the others; a tracker key is plain text; a text task
       gets nothing;
     - what changed, and why;
     - Testing: what the checks cover, and manual steps as
       `- [ ] Manual step: …`, commands before UI clicks;
     - on the first unit, the plan and its change log.
   - Then `pr.sh create <wt> '<title>' <block-file>`. Exit 1: GitHub refused a
     draft — stop and tell the user; never open a ready PR.
7. **Report**: the PR link, what is in it, how many notes of the
   self-review wait on the lines, and that the code and the diff against the
   base are in the IDE ("Open Code in New Window" on this session in the Ajmo
   panel). Then print *Commands* and start the listener (Step 3).

### Commands

Print this block as is after the report of Step 2, and on `help`:

```
In the IDE — on any line of a diff or a file:
  For Agent      what to change here, or a question; reply in a thread the same way
  Sync           the button in the Draft view: I read what you wrote, change the code and answer
In a note of mine:  fix · ok · delete · why?
In a reviewer's thread:
  For Agent      valid · valid, but … — I fix it; a question — I answer you;
                 answer · answer: … — I write the reply for the reviewer
  For Reviewer   your own reply, word for word
  ✓              resolve the thread on GitHub
  Post           the cloud button in the Draft view: the replies go into your draft review

In this session:
  sync     the same as the Sync button
  draft    the same as Post; you submit the review on GitHub
  watch    follow CI, conflicts and the merge; I tell you about new comments
  status   where the task stands
  pause    stop following and let me edit outside the worktrees; "watch" resumes
  help     this list
```

## Step 3 — The IDE: comments on the lines and the reviewers' threads

**The listener.** The user asks for a pass either by typing `sync` here or by
pressing Sync in the IDE. To hear the buttons, keep one listener running:
start it with the Bash tool and `run_in_background: true`:

```
bash "${CLAUDE_PLUGIN_ROOT}/skills/code-review/scripts/threads.sh" wait <scratch>
```

It blocks until a button is pressed and exits with one line; you are woken
then. Do not check on it in between.

| Listener line | Then |
|---|---|
| `SYNC` | run a pass (below), then start the listener again |
| `DRAFT` | publish (below), then start the listener again |
| `GONE` | the task's folder was removed: say `Task folder removed; the task is over.` and stop |
| exit `6` | a listener is already running: nothing to do |

Start it after the report of Step 2 or after adopting a PR, and again after
every pass it woke you for. A pass the user started by typing leaves the running listener as it
is.

| The user says | You do |
|---|---|
| «синк» · `sync` | run a pass |
| «драфт» · `draft` | publish |
| «следи» · `watch` | Step 4 |
| «статус» · `status` | summarize `follow.sh status <key>` (`task.sh status <key>` while no unit has a PR) |
| «пауза» · `pause` | stop the watcher, `task.sh deactivate <key>`; «следи» resumes and re-activates |
| «продолжай» · `resume` | `task.sh activate <key>`, then *Resume* |
| «помощь» · `help` | print *Commands* |
| a change to the code, in words | make it as in a pass, without a thread |

**A pass.**

```
bash "${CLAUDE_PLUGIN_ROOT}/skills/code-review/scripts/threads.sh" fold <scratch>
bash "${CLAUDE_PLUGIN_ROOT}/skills/code-review/scripts/threads.sh" pending <scratch>
```

`fold` takes in what the user wrote since the last pass; `pending` lists the
threads that wait for you. A thread's `root` is its unit's worktree (`<wt>`);
`path` and `line` are in it. For each thread:

1. **Read** the user's comments after your last one, and what the thread is
   about:
   - a thread the user started on a line → that code in `<wt>`;
   - a note of yours → the note;
   - a thread from GitHub (its id starts with `gh:`) → the conversation
     there, first:

     ```
     bash "${CLAUDE_SKILL_DIR}/scripts/discussion.sh" thread <wt> <thread-id>
     ```
2. **Do** what is asked (table below), within the decision ladder: a rung-5
   choice is a question back in the thread, not a change.
3. **Close** the thread, one way only:
   - you changed code → a one-line reply with what changed and the
     commit's short sha (`threads.sh reply`, body on stdin);
   - you answer or ask → a reply;
   - nothing to say («ок», thanks) → `threads.sh ack`;
   - the thread is no longer needed (your note, done with) →
     `threads.sh state <scratch> <id> dropped`. Never drop a thread from
     GitHub or one the user started.

   No thread ends a pass still pending.

| In the thread (RU · EN) | You do |
|---|---|
| a change on a line («вынеси в хелпер», `rename to …`) | make it, commit |
| a question about the code | answer with a reply |
| under a note of yours: `исправь` · `fix` | fix it, commit, reply |
| under a note of yours: `ок`, `оставь` · `ok`, `keep` | ack |
| under a note of yours: `удали` · `delete` | drop the thread |
| in a reviewer's thread: `valid`, `valid, но …` · `valid, but …` | fix what the reviewer asked, refined by what follows `valid`; commit; reply to the user. Nothing is written to the reviewer: they see the commit and close the thread themselves |
| in a reviewer's thread: `ответь` · `answer`, `ответь: …` · `answer: …` | write the reply for the reviewer — yours, or the one dictated — with `discussion.sh reply <wt> <id> --finding`, then a one-line reply to the user that it goes out with `draft` |
| in a reviewer's thread: a question («он прав?») | read the thread and the code, answer the user with a reply; propose what to do |
| `invalid`, `не согласен` in a reviewer's thread | no code. Propose a reply for the reviewer in your reply to the user; write it only on `answer` |

After the threads:

1. **Commit and push.** Commits per the invariants, one per thread when the
   changes are separate. A unit with a PR: `push.sh <wt>` (exit codes as in
   Step 2.5) — a fix counts once the reviewer can see it. A unit without a
   PR: commit only.
2. **Keep the threads on their lines.** Your edits moved code: for every
   open thread in a file you changed (`threads.sh list`), put it where its
   code is now — `threads.sh place <scratch> <id> <line>`.
3. **Update the PR block** (`pr.sh block`) when what it says is no longer
   true.
4. **Look at the discussion** of each unit with a PR:

   ```
   bash "${CLAUDE_SKILL_DIR}/scripts/discussion.sh" open <wt>
   bash "${CLAUDE_SKILL_DIR}/scripts/discussion.sh" news <wt>
   ```

   - `open`: count the threads other people started that have no `local`
     record — they wait for the user's verdict. A thread a bot started
     (`bot`) with no `local` record gets your opinion once, as a note for the
     user: `discussion.sh reply <wt> <id>` (no `--finding`) saying whether the
     bot is right and what you would change. Then it waits like the others.
   - `news`: review bodies and PR comments not shown yet. Summarize those
     of people for the user in the session; a bot's PR comment (`bot`: a
     preview link, a report) is not worth a line. Then `task.sh seen <key>
     <id>…` for all of them.
5. **One line in the session**, zero parts left out; the news summary, if
   any, follows it:

   ```
   Handled <n> threads; pushed <sha7>. <n> reviewer threads wait for your verdict. <n> replies wait for `draft`.
   ```

   `Nothing new in the IDE.` when there was nothing at all.

**Publish** (`draft`, or the listener's `DRAFT`). Run a pass first, so
nothing the user wrote is missed. Then, for each unit with a PR:

```
bash "${CLAUDE_SKILL_DIR}/scripts/discussion.sh" draft <wt>
```

It puts the user's "For Reviewer" replies, word for word, and your
`--finding` replies, marked `🤖 **AI generated**` by the script, into the
user's pending review. Exit `5` — nothing to publish:
`Draft is up to date: <pr>/files`. Exit `1` — a GitHub call failed: relay the
`failed` lines; `draft` again resumes. Otherwise report, exactly this, zero
counts left out:

```
Draft updated: <pr>/files — replied <n>, edited <n>, deleted <n>. Submit it yourself on GitHub.
```

## Step 4 — Follow the PRs (on the user's command)

«следи» · `watch`: run a pass, then arm the watcher unless one is running,
with the Bash tool and `run_in_background: true`:

```
bash "${CLAUDE_SKILL_DIR}/scripts/follow.sh" watch <key>
```

One watcher per task, next to the listener; don't check on either between
wake-ups. Stop it with the task-stop tool, or with
`kill "$(cat <scratch>/watch-task.pid)"`.

| Watcher line | You do, then arm the watcher again |
|---|---|
| `MERGED <pr>` | Step 5 |
| `CLOSED <pr>` | tell the user; ask what happens to units that depend on it |
| `READY <pr>` | note it: CI now runs in full on that PR |
| `CONFLICTS <pr>` | `base.sh merge <wt>`; exit 11 lists the conflicts. Resolve only mechanical ones (imports, lockfiles, adjacent edits; `git -C <wt> checkout --theirs/--ours -- <path>` is allowed), then `base.sh continue <wt>` and `push.sh <wt>`. Otherwise `base.sh abort <wt>`, `task.sh park <key> conflict:<pr> head:<sha> "<why>"`, and ask the user |
| `CI_FAILED <pr> <checks>` | per check, see *CI* below |
| `CI_DONE <pr>` | every check that ran passed. No thread waiting and no manual step open (`pr.sh steps`) → say that the PR is ready to leave draft; name the skipped checks (`summary.skipped` of `ci.sh state`), which run once it is ready. Otherwise say what is left |
| `COMMENTS <pr> <n>` | news only: say in one line that the PR has `<n>` new comments and that they are in the code window after Refresh. Change nothing, answer nothing; the user says in the threads what to do |
| `AUTH …` / `ERROR …` / no line | relay it in one line; «следи» resumes. Don't re-arm |

**CI.** For each failed check:
1. Read `ci.sh log <wt> <check>` and classify:
   - **real failure** → fix it, commit with `CI-fix: <check>`, push. Once
     `ci.sh fixes` reaches 3, `task.sh park <key> ci:<pr>:<check> head:<sha>
     "<why>"` and tell the user;
   - **flake** → `ci.sh rerun <wt> <check>`. If it refuses (2 reruns already,
     or not an Actions check), treat it as real;
   - **base broken** (the same check fails on the base branch: `gh run list
     --branch <base>`) → `task.sh park <key> ci:<pr>:<check> base:<base>
     "<why>"`, `<base>` being `base` from `ci.sh state`. It wakes when the base
     moves on GitHub; then `base.sh merge`;
   - **passes locally** → `base.sh merge <wt>`, `push.sh <wt>`, and classify
     again.
2. Never "fix" CI by changing workflows, config or tests to pass (see
   Never).

After a CI fix moved code, keep the threads on their lines as after a pass.

## Step 5 — Merged

1. Run `wt.sh finish <wt>`. It refuses when there is work the PR doesn't
   have; then tell the user and leave it.
2. Units waiting on this one (`after`) start now: Step 2, from the fresh
   base.
3. When every unit is merged or closed: stop the watcher, run
   `task.sh deactivate <key>`, and report what shipped. The task's folder
   stays: tell the user that "Delete Session and Files" on this session in
   the Ajmo panel removes it together with what is left of the worktrees.
   Keep the listener: it ends by itself (`GONE`) when the folder is removed.

## Resume

Run `task.sh status <key>` — and `follow.sh status <key>` once a unit has a
PR — and continue where reality stands:
- **a unit with no worktree** (`exists` false, status `planned`) → Step 2;
- **a worktree with uncommitted changes** (`dirty`) → look at them, finish
  and commit, or ask the user when they are not yours;
- **a worktree with no PR** → finish Step 2;
- **a PR and `unpushed` > 0** → `push.sh`: a change only counts once it is on
  the PR;
- **an open PR** → run a pass (Step 3) and offer «следи» (Step 4);
- **a merged PR whose worktree still exists** → Step 5.

`task.sh activate <key>` again before you edit anything, and start the
listener (Step 3) whenever a worktree exists.

## Leaving it in the background

The skill's own tool grant lasts one turn. On first use, tell the user once
that an unattended run needs, in `~/.claude/settings.json` or the project's
`.claude/settings.local.json`:
- the task scripts allowed — the installed path carries the plugin version,
  so the pattern must not pin it;
- the worktrees dir as an additional working directory, because it lies
  outside the project: edits and `git -C` there would prompt otherwise.

```json
{ "permissions": {
    "allow": ["Bash(bash *skills/task/scripts/*)", "Bash(bash *code-review/scripts/threads.sh*)"],
    "additionalDirectories": ["<parent>/<repo>.worktrees"] } }
```
