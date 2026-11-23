---
name: code-review
description: >-
  Review a pull request together with the reviewer inside VS Code, through the
  Ajmo extension: the findings appear as threads on the lines of the code, the
  reviewer answers there, and only the finished comments go to their GitHub
  draft review. Needs the Ajmo VS Code extension.
argument-hint: "<pr-number | pr-url>"
disable-model-invocation: true
allowed-tools: Read, Grep, Glob, Bash, Agent, AskUserQuestion
---

# Code review in the IDE

You run a **workflow**: collect the PR, build real context around its diff,
review it against the rubric, and put the findings where the reviewer reads
the code — in VS Code, in the Ajmo extension, as threads on the lines. The
reviewer answers in those threads; you pick their words up when they say
`sync`. Every finding is located (`file:line`) and concrete.

You and the extension exchange threads through two files in the review's
scratch folder: you write `threads.json`, the extension appends
`inbox.jsonl`. You touch both only through `threads.sh`.

Files bundled with this skill:

- `${CLAUDE_SKILL_DIR}/references/rubric.md` — passes, frontend layer,
  severity + confidence, the finding format. Read before pass 1.
- `${CLAUDE_SKILL_DIR}/scripts/collect.sh` — checks the PR head out and prints
  what is to be reviewed (Step 1). Its header documents the output and the
  exit codes.
- `${CLAUDE_SKILL_DIR}/scripts/threads.sh` — the thread store (Steps 6–7). Its
  header documents the subcommands and the rules.
- `${CLAUDE_SKILL_DIR}/scripts/publish.sh` — brings the reviewer's draft on
  GitHub in line with the threads (Step 8). Its header documents what is
  published, the output lines and the exit codes.
- `${CLAUDE_SKILL_DIR}/scripts/github.sh` — reads the PR's threads that live
  on GitHub and lets you write in one (Steps 7 and 10). Its header documents
  the subcommands and the output.

`<scratch>` below is the `### SCRATCH:` dir, `<worktree>` the path in
`### WORKTREE:`.

## Invariants

- **The working language is the reviewer's.** Everything you tell the
  reviewer in your own words — in the conversation, in the questions you ask
  and in your replies in the threads — is in the language they write to you
  in; English until they have written something. The skill's fixed lines are
  English and printed word for word, only
  the `<…>` filled in: *The closing message*, *Commands*, the lines of Step 7.
- **The session stays short.** The findings live in the threads; the session
  gets the fixed lines, errors and answers to what the reviewer asks here.
- **Comment language** is the language of the findings only. Resolved in
  Step 2.
- **Style, everywhere** — the questions, the findings, the replies: dry and
  businesslike, no slang, only the matter at hand. The code under review is
  neither praised nor graded; a finding states the problem, why it matters,
  and the fix.
- **Severity tags** are `🔴 blocker` · `🟠 should-fix` · `🔵 nit` · `❓ question`:
  emoji, then the English term, unchanged whatever the comment language.
- **GitHub is the outbox.** Nothing goes there until the reviewer says
  `draft`, and then only through `publish.sh`, into their pending review. You
  never submit a review and never write to the PR in any other way.
- **Two kinds of your comments.** A *finding* is meant for the PR author
  (`threads.sh add`, `threads.sh reply --finding`). A *reply* is talk with the
  reviewer (`threads.sh reply`) and will never be published. Do not mix them:
  an answer to the reviewer's question is a reply, never a finding.
- **The reviewer's own comments** — theirs for the PR author (`"to": "github"`)
  — are their review: you never edit, drop or answer one unless they ask you
  to in that thread.
- **Threads on GitHub.** A thread that lives on GitHub — the author's or
  another reviewer's, or one of the reviewer's own already submitted — has the
  id `gh:<node id>`. Its conversation is on GitHub, not in `threads.json`: read
  it with `github.sh thread` before you say anything about it. What you write
  in it is local like everything else; only a `--finding` comment is ever
  published, as a reply in that thread, and only when the reviewer asked you
  to answer there.
- **Read the PR's files in the worktree**, never in the current checkout: it
  may be on another branch.
- **The scratch folder** is the one place for this review's files. Write
  nothing for the review to `/tmp`. Never write to `inbox.jsonl`.

## Step 1 — Collect

The invocation's arguments are `$ARGUMENTS`. Pass the PR reference to the
collector in single quotes — an unquoted `#123` would start a shell comment:

```
bash "${CLAUDE_SKILL_DIR}/scripts/collect.sh" '<argument>'
```

Exit codes:

- `3` — `gh` or `jq` is missing. Relay the script's message and stop.
- `1` / `2` / `4` / `5` — `gh` or `git` failed (no such PR, not logged in, no
  remote for the PR's repository) / not a git repository / bad argument, or
  the scratch belongs to another PR / nothing to review. Relay the script's
  message and stop.

`### NOTE:` lines: the checkout was kept because it has local changes → its
files may be older than the PR, say so in one line; the PR is closed or
merged → say so.

When `<scratch>/threads.json` already holds threads, an earlier run reviewed
this PR. Do not review again on your own. The collector may have moved the
worktree to a newer commit, so carry the threads over first (Step 9, from its
step 3), then tell the reviewer in one line that the threads of the
earlier run are in the IDE and that `re-review` reviews what was pushed
since, print *Commands*, and go to Step 7.

## Step 2 — Configuration (one prompt)

Show the reviewer the target, the changed files (count and the
notable ones) and the PR title. Then ask **three questions in a single
`AskUserQuestion` call**:

1. **Second pass** — yes / no, default no (Step 5).
2. **Comment language** — English, the working language when it is another
   one, or other via the free-text field. Default: the `comment-language:`
   line of the conventions layer (Step 3), else English. Pre-select it.
3. **Focus** — none (default), correctness, tests, or the reviewer types
   their own focus in the free-text field.

Word the questions and the options in the working language.

Restate the resolved values in one line, save them for a later
re-review (Step 10) with the Bash tool, and continue:

```
<scratch>/config.json
{ "secondPass": false, "language": "English", "focus": "" }
```

## Step 3 — Context

A hunk is not enough to judge a change.

- **Read every changed file in full** (`Read`, under `<worktree>`). Apply the
  noise rules from the rubric.
- **Follow the change outward:** `Grep` / `Glob` under `<worktree>` for callers
  of changed functions, the types involved, sibling modules, existing tests.
- **Write the intent statement** — two or three sentences on what the change
  is for, from `### PR TITLE` / `### PR BODY`. It anchors pass 1 and briefs the
  second pass.
- **`### EXISTING COMMENTS`** is what is already raised on the PR. A point made
  there is not a new finding; mention it only when you add something to it.
- **Project conventions layer.** A repo may add its own rules at
  `.claude/skills/code-review-conventions/SKILL.md` (read it under
  `<worktree>`); the rubric is the base, the layer adds to and overrides it,
  and wins on any direct conflict. A `comment-language: <value>` line in it
  sets the repo's default for Step 2.

## Step 4 — Pass 1

Read `${CLAUDE_SKILL_DIR}/references/rubric.md` and work its passes in order
over the context from Step 3, focus areas at elevated priority. Hold the
findings until Step 6.

## Step 5 — Second pass (only if chosen in Step 2)

An independent opinion, unanchored by pass 1. Spawn one sub-agent with the
`Agent` tool. Its brief contains:

- the absolute paths of `rubric.md` and of the conventions layer (if any) — it
  reads them itself;
- what to read: the worktree path, and the base and head commits from
  `### BASE:` and `### WORKTREE:` for `git diff <base> <head>` there — it must
  not run the collector, which would move the worktree under you. It reads the
  changed files in full;
- the intent statement and the focus areas (as elevated priorities to
  scrutinize, not as findings to confirm);
- the return format: the rubric's finding format, numbered.

The brief carries none of pass 1's findings — an uncontaminated look is the
whole point.

**Merge** the two lists into one:

- **Corroborated** (same file, ~same line, same root cause): keep one entry,
  confidence `high`.
- **Singletons**: keep and judge on the merits — a singleton is a signal, not a
  verdict.

## Step 6 — Into the IDE

No approval step: the threads are local, visible only to the reviewer, and
curation happens there.

1. **Render** each finding in the comment language, style per the invariants:
   severity tag, problem, why, fix; confidence and the pass marks removed. One
   finding is one thread. No `🤖` marker: the extension shows who wrote what.
2. **Write the batch** to `<scratch>/batch.json`:

   ```json
   { "comments": [ { "path": "src/x.ts", "line": 42, "body": "🔴 **blocker** — …" } ] }
   ```

   `path` is relative to the repository root; `line` is the line of the file
   at the PR head (the new side). A finding about a removed line takes
   `"side": "LEFT"` and the line of the base file. A finding in a file outside
   the diff goes in too: the IDE shows it on its line.
3. **Add** them in one call:

   ```
   bash "${CLAUDE_SKILL_DIR}/scripts/threads.sh" add <scratch> <scratch>/batch.json
   ```

   Exit `5` — the batch is empty; nothing to add.
4. **Record the reviewed commit**, also when there was nothing to add:

   ```
   bash "${CLAUDE_SKILL_DIR}/scripts/threads.sh" reviewed <scratch>
   ```
5. **Close** with *The closing message*.
6. **Listen** for the Sync button (Step 7, *The listener*).

### The closing message

After a review, exactly this and nothing else — no findings, no counts;
`<Commands>` is the block from *Commands*:

```
Review is in the IDE: <n> threads. In the Ajmo panel open this session's menu → "Open Code in New Window".

<Commands>
```

When the review found nothing worth raising, the first line is
`Review found nothing to raise.`

### Commands

The closing message and `help` print this block as is:

```
In the IDE — on any line of a diff or a file:
  For Agent    a question or a command for me; reply in a thread the same way
  For Author   your own review comment; I do not touch it
  Sync         the button in the Draft view: I read what you wrote and answer
  Post         the cloud button in the Draft view: the same as `draft` below
In a thread of mine:
  delete · shorter · softer · rephrase: … · en / ru
  nit · should-fix · blocker · question
  suggest fix · where else? · why? → ok
In a thread from GitHub (somebody's comment, or yours already submitted):
  For Author   your reply in that thread; goes to GitHub with the next draft
  For Agent    ask me about it; "answer: …" and I write the reply for the author

In this session:
  sync        the same as the Sync button; also moves the review to new commits on the PR
  re-review   review what was pushed since the last review and check your earlier comments
  draft       put the findings, your comments and replies into your draft review on GitHub
  help        this list
```

## Step 7 — Sync (on the reviewer's command)

**The listener.** The reviewer asks for a sync either by typing `sync` here or
by pressing Sync in the IDE. To hear the button, keep one listener running:
start it with the Bash tool and `run_in_background: true`:

```
bash "${CLAUDE_SKILL_DIR}/scripts/threads.sh" wait <scratch>
```

It blocks until the button is pressed and exits with one line; you are woken
then. Do not check on it in between.

| Listener line | Then |
|---|---|
| `SYNC` | run a pass (below), then start the listener again |
| `DRAFT` | the reviewer pressed "Post the Draft to GitHub": publish (Step 8), then start the listener again |
| `GONE` | the review's folder was removed: say `Review folder removed; the review is over.` and stop |
| exit `6` | a listener is already running: nothing to do |

Start it after the closing message, and again after every pass it woke you
for. A pass the reviewer started by typing `sync` leaves the running listener
as it is. The reviewer may write here meanwhile; answer as usual.

| The reviewer says | You do |
|---|---|
| «синк» · `sync` | run a pass (below) |
| «помощь» · `help` | print *Commands* |
| a request across all findings («убери все nit» · `drop all nits`, «переведи всё на en» · `translate all to en`) | apply it to every finding of yours and report in one line |
| «драфт» · `draft` | publish (Step 8) |
| «ре-ревью» · `re-review`, a request to look at the new commits | re-review (Step 10) |
| «стоп» · `stop` | there is nothing to stop: the review ends when the reviewer deletes this session in the Ajmo panel ("Delete Session and Files"). Say so in one line |

**A pass.**

```
bash "${CLAUDE_SKILL_DIR}/scripts/threads.sh" fold <scratch>
bash "${CLAUDE_SKILL_DIR}/scripts/threads.sh" pending <scratch>
```

`fold` takes in what the reviewer wrote since the last pass; `pending` lists
the threads that wait for you. For each:

1. **Read** the reviewer's comments after your last comment in the thread, and
   the target: your finding in the thread — or, when the thread starts with
   the reviewer's own comment, that comment — or, when it starts with a
   question to you, the line the thread sits on (`path`, `line`; read the code
   in `<worktree>`). When the thread is on GitHub — its id starts with `gh:`,
   or it has a `github` field and so may have answers from the author — read
   that conversation first:

   ```
   bash "${CLAUDE_SKILL_DIR}/scripts/github.sh" thread <scratch> <thread-id>
   ```
2. **Do** what is asked (table below). Commands are free text in any
   language — the table gives Russian and English examples; interpret them. Rewritten text follows the invariants and the
   comment language unless the command names another language.
3. **Close** the thread, one way only:
   - you changed a finding → `threads.sh edit`, then a one-line reply
     saying what changed, so the reviewer sees it happened;
   - you answer or ask → a reply (`threads.sh reply`, body on stdin);
   - nothing to say («ок», «оставь», thanks) → `threads.sh ack`;
   - the thread is no longer needed → `threads.sh state <scratch> <id> dropped`.

   No thread ends a pass still pending.

4. **Check for new commits** once the threads are handled:

   ```
   bash "${CLAUDE_SKILL_DIR}/scripts/collect.sh" '<pr>' --check
   ```

   `moved …` — the author pushed since the review: go on with Step 9 from its
   step 2 right away, without being asked. `same …` — nothing to do.

Then one line in the session: `Handled <n> threads.`, or `Nothing new in the
IDE.` when there were none; after a move, the report of Step 9 follows it.

| In the thread (RU · EN) | You do |
|---|---|
| `удали` · `delete` | drop the thread (yours only; a thread that starts with the reviewer's own comment is theirs to delete in the IDE — say so in a reply) |
| `короче`, `мягче`, `переформулируй: …`, `en` · `shorter`, `softer`, `rephrase: …`, `ru` | rewrite your finding in place (`edit <comment-id>`) |
| `nit` · `should-fix` · `blocker` · `question` (same in both) | change the tag; rewrite the text when the tag changes what it says |
| `предложи фикс` · `suggest fix` | append a `suggestion` block that replaces exactly the commented line; a wider fix goes into a plain code block |
| `где ещё?` · `where else?` | find the same problem elsewhere in the diff and add those `path:line` to the finding |
| `почему?` · `why?`, any question | answer with a reply |
| `ок`, `оставь` · `ok`, `keep` | ack; the finding stays as it is |
| `оформи` · `write up` under the reviewer's own comment | add a finding of yours to that thread (`reply --finding`) that makes their point — tag, problem, why, fix; their comment stays, it is theirs to delete |
| a question in a thread from GitHub («он прав?», «что ответить?») | read the thread and the code, answer with a reply; when an answer to the author is due, put its text into the reply as a proposal |
| `ответь` · `answer`, `ответь: …` · `answer: …` in a thread from GitHub | write the answer for the author — yours, or the one the reviewer dictated, in the comment language — with `reply --finding`, and add a one-line reply that it goes to GitHub with the next `draft` |
| a hypothesis or a question on a line with no finding | check it against the code. Confirmed → `reply --finding` with the finding. Not confirmed → a reply saying why |

## Step 8 — Draft (on the reviewer's command)

`draft` brings the reviewer's pending review on GitHub in line with the
threads: your findings and their own comments go in, the talk between you
stays out. It can be said any number of times; each run publishes only what
changed since the last one.

1. **Run a pass first** (Step 7), so nothing the reviewer wrote is missed. If
   the pass leaves a question of yours open in a thread, publish anyway: the
   talk is not published.
2. **Publish:**

   ```
   bash "${CLAUDE_SKILL_DIR}/scripts/publish.sh" <scratch>
   ```

   Exit codes:
   - `5` — the draft already matches the threads: `Draft is up to date: <pr>/files`.
   - `8` — the PR has new commits since the review, nothing was written. Run
     Step 9, then publish again. Use `--allow-moved` only when the
     reviewer insists on publishing against the old code.
   - `1` — a GitHub call failed; some actions may have gone in. Relay the
     `failed` lines and say that `draft` again resumes from there.
3. **Report**, exactly this; `<…>` from the script's last line, zero counts
   left out:

   ```
   Draft updated: <pr>/files — added <n>, replied <n>, edited <n>, deleted <n>. Submit it yourself on GitHub.
   ```

   When lines were `skipped` (a file outside the PR's diff has no place on
   GitHub), append those findings in full, in the comment language, under the
   line `Not in the diff — for your summary:`. When lines were `kept`, add
   `Already submitted, left as is: <path:line, …>`.

The `🤖 **AI generated**` marker on your findings is added by the script; do
not write it into the threads.

## Step 9 — Update (the PR has new commits)

Not a command of its own: it runs at the end of every pass that finds the
head moved (Step 7), and before publishing (Step 8). When the reviewer asks to
update or to pick up new commits, that is a `sync`. The review moves to the
new code: threads follow their lines, findings the push fixed leave, and the new
code itself is not reviewed here.

1. **The reviewer's comments are in the threads already:** you come here from
   a pass, which folded them in. Never move the worktree before that.
2. **Move the worktree:** run the collector again, as in Step 1. When its note
   says the checkout was kept for its local changes, stop: tell the reviewer
   in one line that the checkout has local changes and was not moved.
3. **Carry the threads over:**

   ```
   bash "${CLAUDE_SKILL_DIR}/scripts/threads.sh" rebase <scratch>
   ```

   `nothing to rebase` — the head did not move: say `No new commits on the PR.`
   and stop. Otherwise it prints `moved` and `outdated` lines and
   `rebased <old> → <new>`.
4. **Look again at every `outdated` thread** (`threads.sh list`): the push
   changed the code under it. Read the new code in `<worktree>`.
   - Your finding is fixed, and the thread holds nothing but it → drop the
     thread.
   - Your finding is fixed, but the reviewer wrote in the thread → leave it,
     and reply that the push fixed it; they decide.
   - It still applies → `threads.sh place <scratch> <thread-id> <line>` with
     its line in the new code, and rewrite the finding (`edit`) when the new
     code changes what it should say.
   - The thread starts with the reviewer's own comment → never drop or edit
     it; `place` it when you can tell where it belongs now, else leave it
     marked.
5. **Report**, exactly this, zero counts left out:

   ```
   Review moved to <sha7>: <n> threads carried over, <n> findings removed as fixed, <n> left for you to check.
   The PR has new commits; the new code is not reviewed.
   ```

   Inside a re-review (Step 10) this report is not printed.

A thread already in the GitHub draft keeps its place there: GitHub marks it
outdated itself when the code under it changed.

## Step 10 — Re-review (on the reviewer's command)

`re-review` reviews what the author pushed since the last review and says
what became of the earlier comments. Nothing is asked again: the
configuration is `<scratch>/config.json` (none → no second pass, the language
of the existing findings, no focus). Everything it produces is local, as
after the first review.

1. **Run a pass** (Step 7), without its closing line. It takes in what the
   reviewer wrote and, when the head moved, carries the threads over (Step 9).
2. **Collect** again, as in Step 1, and look at `### REVIEWED:`.
   - It equals the commit in `### WORKTREE:` → nothing was pushed since: say
     `Nothing new to review since <sha7>.` and stop.
   - There is none → the earlier run recorded no commit: review the whole
     `### DIFF`, and say so in one line.
   - Otherwise the subject is `### DELTA`, with `### COMMITS SINCE THE REVIEW`
     as the author's account of it. Mind the note about a rebase: after one,
     the delta may hold changes that are not the author's.
3. **Context**, as in Step 3 but for the delta: read every file it touches in
   full, follow the changes outward, read the conventions layer.
4. **Review the delta** by the rubric (Step 4), with the saved focus; with
   `secondPass`, brief the sub-agent as in Step 5, with the reviewed commit as
   the base of its `git diff`. A finding here is a problem the new commits
   brought in, or one they made matter. Code the earlier review already
   passed over is not reviewed again. Raise nothing that a thread already
   says: check `threads.sh list` and the list of the next step.
5. **Check the earlier comments:**

   ```
   bash "${CLAUDE_SKILL_DIR}/scripts/github.sh" open <scratch>
   ```

   Take every thread there that the reviewer started (`mine`) or that belongs
   to this review (`local` is set), except those the author has not seen yet
   (every comment is a `draft`). Read the code it points at in `<worktree>`
   and write a verdict into the thread, as a plain reply — never
   `--finding`:
   - **fixed** — the code now does what the comment asked: say so and name
     the commit or the line. The reviewer resolves the thread on GitHub.
   - **not fixed** — nothing changed and the author did not answer.
   - **answered** — the author replied instead of, or along with, a change:
     say whether the answer holds against the code, and propose a reply to
     the author; the reviewer says `answer` in the thread to have it written.

   The verdict goes to the thread's local record: `threads.sh reply <scratch>
   <local>` when `local` is set, else `github.sh reply <scratch> <id>` (body
   on stdin), which starts the record. Skip a thread whose last local comment
   is your verdict when neither its code nor its conversation changed since.
6. **Add the new findings** (Step 6, its steps 1–3) and record the commit:
   `threads.sh reviewed <scratch>`.
7. **Report**, exactly this, zero counts left out, then keep listening:

   ```
   Re-review of <sha7>: <n> new threads. Earlier comments: <n> fixed, <n> not fixed, <n> answered by the author. All of it is in the IDE.
   ```

## Leaving the session in the background

The skill's own tool grant lasts only for the turn it starts in, so a later
`sync` may stop at a permission prompt for the scripts. To avoid that, the
reviewer can allow them in `~/.claude/settings.json`:

```json
{ "permissions": { "allow": [
  "Bash(bash *code-review/scripts/collect.sh*)",
  "Bash(bash *code-review/scripts/threads.sh*)",
  "Bash(bash *code-review/scripts/publish.sh*)",
  "Bash(bash *code-review/scripts/github.sh*)"
] } }
```
