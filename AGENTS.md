# Ajmo

A VS Code extension, a workbench for Claude Code agents: a side panel with
every session and its status, so the user notices when an agent is waiting,
and a review panel for reading a session's changes and talking to the agent
on the lines. See `README.md` for what it does.

## Commands

    npm run typecheck   # tsc, no emit
    npm test            # logic and script tests; node:test runs TypeScript directly (Node ≥ 22.18), the script tests need bash, git, jq
    npm run smoke       # built extension against a vscode stub and a fake claude
    npm run package     # .vsix

## Layout

Two parts that share one small module; keep them apart.

- Agents: `src/model.ts` (logic), `src/extension.ts` (polling, tree,
  commands, terminals), `src/filterView.ts` (the "Search & Filter" view).
- Review, the "Review" panel of a code window: `src/reviewModel.ts` (logic),
  `src/review.ts` (diffs against the base, GitHub line comments, the user's
  threads).
- Shared: `src/skills.ts` — worktree, PR and skill-file conventions;
  `src/protocol.ts` — the thread files of `docs/review-protocol.md`.
- Logic modules import no `vscode` and have a test file each in `test/`;
  `test/threads-script.test.ts` runs the plugin's `threads.sh` (needs `jq`)
  against the panel's reader, and `test/task-script.test.ts` runs the task
  scripts on a temp repository with a local remote.
- `media/` — the icon: `ajmo.svg` for the activity bar and
  `ajmo.woff`, the same shape as a one-glyph icon font for the status
  bar and terminal tabs (see `docs/vscode.md` for how to rebuild it);
  `thread-*.svg` are codicon copies used as comment avatars; `icon.png` is
  the Marketplace icon, built from `icon.svg`.
- `fake/` — fake `claude` and the smoke script.
- `plugin/` — the Claude Code plugin `ajmo`: the skill `code-review`, the
  other end of `docs/review-protocol.md`, and the skill `task` with its
  `critic` agent and `lib/`, a fork of `korvin89:task`;
  `.claude-plugin/marketplace.json` at the root makes it installable. Its version follows the extension's. Validate with
  `claude plugin validate plugin`.

## Rules

- Put logic in a logic module with a test; keep `extension.ts` and
  `review.ts` to wiring. The review part must not import from the agents
  part or the other way round.
- Session state comes only from `claude agents --json --all`. Do not parse
  files under `~/.claude/jobs/`. The panel reads the skills' files
  (`<repo>/.git/ajmo/` and `<repo>/.git/code-review/`) only for PR links,
  worktrees and review threads, and writes only `inbox.jsonl` and
  `sync.request`, in the scratch folder of a review or a task. It removes an
  `ajmo` review or task on "Delete Session and Files"; on GitHub it only
  resolves and unresolves threads.
- Write every project text in English.
- Do not add dependencies without asking.
- Tests and the smoke run do not prove VS Code behaviour. Say what was
  actually verified; ask the user to check the rest in a real window.
- For a non-obvious choice, ask the user first and offer a default.
- Every change: bump the version in `package.json`, in
  `plugin/.claude-plugin/plugin.json` and in the README install line,
  rebuild the `.vsix`, commit to `main` and tag `v<version>`. The
  repository is local only; do not push or create a GitHub repository unless
  asked. When it is published, it goes as a single initial commit: the local
  history holds internal names and must not be pushed.
- The README is for somebody who has never seen the project: what it is,
  how to install it, how to use it. It does not mention `korvin89`; the
  panel's support for that plugin's files is described in `docs/` only.
- Do not change the user's `korvin89` skills plugin from here; describe the
  needed change to the user instead. The `ajmo` plugin in `plugin/` is ours:
  its skills are forks of `korvin89:code-review` and `korvin89:task` for the
  IDE flow. Read `korvin89` freely; copy from it, never write to it. The
  review rubric (`plugin/skills/code-review/references/rubric.md`) is the
  same as `korvin89:code-review`'s: a rule changed here belongs there too,
  so tell the user.

## Docs

Read the one that matches the task before changing anything:

- `docs/decisions.md` — the choices behind the product and the ideas that
  were rejected. Do not revisit them unasked. Keep it short: a decision goes
  there only when the code and the README do not already say it.
- `docs/claude-cli.md` — what the CLI and the Claude Code extension actually
  return and do, and how far each fact is verified.
- `docs/vscode.md` — VS Code limits and workarounds this extension relies on.
- `docs/review-protocol.md` — the files through which the panel and the
  user's skills exchange review threads.
- `docs/roadmap.md` — what is built but not yet checked by the user, and
  what is left to build.
