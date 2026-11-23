// The task skill's scripts (plugin/skills/task/scripts) on a real temp
// repository with a local "origin", and what the panel reads from their
// files. Nothing here talks to GitHub. Needs bash, git and jq.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as skills from '../src/skills.ts';

const DIR = path.join(import.meta.dirname, '..', 'plugin', 'skills', 'task', 'scripts');

function setup(): { repo: string; sh: (script: string, args: string[], opts?: { input?: string; session?: string; pid?: number }) => { code: number; out: string; err: string };
  git: (cwd: string, ...args: string[]) => string; } {
  const top = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ajmo-task-')));
  const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' });
  const origin = path.join(top, 'origin.git');
  const repo = path.join(top, 'repo');
  fs.mkdirSync(origin);
  git(origin, 'init', '--quiet', '--bare', '--initial-branch=main');
  git(top, 'clone', '--quiet', origin, 'repo');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  git(repo, 'checkout', '--quiet', '-b', 'main');
  git(repo, 'add', 'a.txt');
  git(repo, 'commit', '--quiet', '-m', 'first');
  git(repo, 'push', '--quiet', 'origin', 'main');
  const sh = (script: string, args: string[], opts: { input?: string; session?: string; pid?: number } = {}) => {
    const r = spawnSync('bash', [path.join(DIR, script), ...args], { cwd: repo, encoding: 'utf8', input: opts.input ?? '',
      env: { ...process.env, CLAUDE_CODE_SESSION_ID: opts.session ?? 's1', CLAUDE_PID: String(opts.pid ?? process.pid),
        GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } });
    return { code: r.status ?? -1, out: r.stdout.trim(), err: r.stderr.trim() };
  };
  return { repo, sh, git };
}

test('task scripts: from a task to a pushed branch, and what the panel finds', () => {
  const { repo, sh, git } = setup();
  const scratch = path.join(repo, '.git', 'ajmo', 'task-t-1');

  assert.equal(sh('task.sh', ['list']).out, 'no tasks in flight in this repository');
  const init = sh('task.sh', ['init', 't-1', 'text', 'cache ttl'], { input: 'Make the TTL configurable.\n' });
  assert.equal(init.out, scratch, 'the task lives in the ajmo folder, where the panel looks');
  assert.equal(fs.readFileSync(path.join(scratch, 'brief.md'), 'utf8'), 'Make the TTL configurable.\n');
  assert.equal(skills.lockSessionId(fs.readFileSync(path.join(scratch, 'lock'), 'utf8')), 's1', 'the panel matches the session by the lock');

  assert.equal(sh('task.sh', ['unit', 't-1', 'api']).out, 't-1-api');
  const wt = sh('wt.sh', ['create', 't-1', 'api']).out;
  assert.equal(wt, `${repo}.worktrees/t-1-api`, 'the worktree is next to the repository, named after the branch');
  const json = (): string => fs.readFileSync(path.join(scratch, 'task.json'), 'utf8');
  assert.deepEqual(skills.taskWorktrees(json()), [{ label: 'api', dir: wt }], 'Open Code finds the worktree');
  assert.deepEqual(skills.taskCleanup(json()), { worktrees: [wt], branches: ['t-1-api'] });
  assert.equal(skills.repoRoot(wt), repo);

  fs.writeFileSync(path.join(wt, 'b.txt'), 'two\n');
  const status = (): { active: boolean; units: { exists: boolean; dirty: boolean; pushed: boolean; unpushed: number }[] } =>
    JSON.parse(sh('task.sh', ['status', 't-1']).out);
  assert.deepEqual([status().units[0]?.exists, status().units[0]?.dirty, status().units[0]?.pushed], [true, true, false]);
  assert.equal(sh('push.sh', [wt]).code, 7, 'uncommitted changes are never pushed');
  git(wt, 'add', 'b.txt');
  git(wt, 'commit', '--quiet', '-m', 'second');
  assert.equal(sh('push.sh', [wt]).code, 4, 'no push before the checks are recorded');
  sh('task.sh', ['checks', 't-1', 'false']);
  assert.equal(sh('push.sh', [wt]).code, 10, 'a failed check stops the push');
  sh('task.sh', ['checks', 't-1', 'test -f b.txt']);
  assert.equal(status().units[0]?.unpushed, 1);
  const pushed = sh('push.sh', [wt]);
  assert.match(pushed.out, /^pushed [0-9a-f]{40} to origin\/t-1-api$/m);
  assert.equal(git(repo, 'ls-remote', '--heads', 'origin', 't-1-api').trim().split('\t')[0], git(wt, 'rev-parse', 'HEAD').trim());
  assert.deepEqual([status().units[0]?.dirty, status().units[0]?.pushed, status().units[0]?.unpushed], [false, true, 0]);

  assert.equal(sh('task.sh', ['show', 't-1'], { session: 's2', pid: 1 }).code, 0, 'reading is open to any session');
  assert.equal(sh('task.sh', ['unit', 't-1', 'ui'], { session: 's2', pid: 1 }).code, 9, 'a second live session cannot drive the task');
});

test('guard.sh: while a task is active, edits and git writes stay in its worktrees', () => {
  const { repo, sh } = setup();
  sh('task.sh', ['init', 't-2', 'text', 'x'], { input: 'x' });
  sh('task.sh', ['unit', 't-2', 'one']);
  const wt = sh('wt.sh', ['create', 't-2', 'one']).out;
  const ask = (tool: string, input: object, session = 's1'): string =>
    sh('guard.sh', [], { input: JSON.stringify({ session_id: session, cwd: repo, tool_name: tool, tool_input: input }) }).out;
  const denied = (out: string): boolean => out.includes('"permissionDecision": "deny"');

  assert.equal(ask('Edit', { file_path: path.join(repo, 'a.txt') }), '', 'no opinion before the task is activated');
  sh('task.sh', ['activate', 't-2']);
  assert.equal(JSON.parse(sh('task.sh', ['status', 't-2']).out).active, true);
  assert.ok(denied(ask('Edit', { file_path: path.join(repo, 'a.txt') })), "the user's checkout is closed");
  assert.equal(ask('Edit', { file_path: path.join(wt, 'a.txt') }), '', 'the worktree is open');
  assert.equal(ask('Write', { file_path: path.join(repo, '.git', 'ajmo', 'task-t-2', 'plan.md') }), '', 'so is the scratch');
  assert.equal(ask('Edit', { file_path: path.join(repo, 'a.txt') }, 'other'), '', 'another session is not confined');
  assert.ok(denied(ask('Bash', { command: `git -C ${wt} push origin HEAD` })), 'no raw push');
  assert.ok(denied(ask('Bash', { command: 'git commit -m x' })), 'no git writes outside a worktree');
  assert.equal(ask('Bash', { command: `git -C ${wt} commit -m "x"` }), '');
  assert.ok(denied(ask('Bash', { command: 'gh pr ready 5' })), 'draft/ready is the user\'s');
  assert.equal(ask('Bash', { command: 'gh pr view 5 --json url' }), '');
  sh('task.sh', ['deactivate', 't-2']);
  assert.equal(ask('Edit', { file_path: path.join(repo, 'a.txt') }), '', 'pause lifts it');
});

test('every script of the plugin parses', () => {
  const root = path.join(import.meta.dirname, '..', 'plugin');
  const scripts = (fs.readdirSync(root, { recursive: true }) as string[]).filter((f) => f.endsWith('.sh'));
  assert.ok(scripts.length >= 15);
  for (const f of scripts) {
    const r = spawnSync('bash', ['-n', path.join(root, f)], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${f}: ${r.stderr}`);
  }
});
