// The skill's thread store (plugin/skills/code-review/scripts/threads.sh) and
// the panel's reader (src/protocol.ts) must agree on the files. Needs bash and jq.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as protocol from '../src/protocol.ts';

const SCRIPT = path.join(import.meta.dirname, '..', 'plugin', 'skills', 'code-review', 'scripts', 'threads.sh');
const run = (args: string[], input?: string): string => execFileSync('bash', [SCRIPT, ...args], { encoding: 'utf8', input });
const code = (args: string[], input?: string): number => spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', input }).status ?? -1;

function scratch(): { dir: string; say: (e: object) => void; shown: () => protocol.LocalThread[]; file: () => { cursor: number; head?: string; threads: protocol.LocalThread[] } } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ajmo-threads-'));
  const read = (name: string): string => { try { return fs.readFileSync(path.join(dir, name), 'utf8'); } catch { return ''; } };
  return {
    dir,
    // What the extension does when the reviewer writes something.
    say: (e) => fs.appendFileSync(path.join(dir, 'inbox.jsonl'), `${JSON.stringify(e)}\n`),
    // What the extension shows.
    shown: () => protocol.localThreads(read('threads.json'), read('inbox.jsonl')),
    file: () => JSON.parse(read('threads.json')),
  };
}

test('threads.sh: findings, a conversation and a sync, as the panel sees them', () => {
  const s = scratch();
  const batch = path.join(s.dir, 'batch.json');
  fs.writeFileSync(batch, JSON.stringify({ comments: [
    { path: 'src/a.ts', line: 10, body: '🟠 **should-fix** — leaks.' },
    { path: 'src/b.ts', line: 3, side: 'LEFT', body: '🔵 **nit** — typo.' },
  ] }));
  const added = run(['add', s.dir, batch]).trim().split('\n');
  assert.equal(added.length, 2);
  assert.match(added[0] ?? '', /^added t-[0-9a-f]{12} src\/a\.ts:10$/);
  const [t1, t2] = s.shown();
  assert.ok(t1 && t2);
  assert.deepEqual([t1.path, t1.line, t1.side, t1.state, t1.comments[0]?.author], ['src/a.ts', 10, 'RIGHT', 'open', 'agent']);
  assert.equal(t2.side, 'LEFT');
  assert.deepEqual(JSON.parse(run(['pending', s.dir])), [], 'nothing waits before the reviewer writes');

  // The reviewer answers a finding, writes their own comment and a question on a new line.
  s.say({ type: 'comment', id: 'c1', thread: t1.id, to: 'agent', body: 'why?' });
  s.say({ type: 'comment', id: 'c2', thread: 'n1', to: 'github', body: 'Rename this.', anchor: { path: 'src/c.ts', line: 7, side: 'RIGHT' } });
  s.say({ type: 'comment', id: 'c3', thread: 'n2', to: 'agent', body: 'is this safe?', anchor: { path: 'src/d.ts', line: 1, side: 'RIGHT' } });
  fs.appendFileSync(path.join(s.dir, 'inbox.jsonl'), '{torn line\n');
  assert.equal(protocol.unsentCount(s.shown()), 3);
  const before = s.shown();

  assert.equal(run(['fold', s.dir]).trim(), 'folded 3');
  assert.equal(s.file().cursor, 3, 'the torn line is not counted, as in the panel');
  assert.deepEqual(s.shown().map((t) => [t.id, t.comments.map((c) => c.id)]), before.map((t) => [t.id, t.comments.map((c) => c.id)]),
    'the panel shows the same threads before and after the sync');
  assert.equal(protocol.unsentCount(s.shown()), 0);

  const pending = JSON.parse(run(['pending', s.dir])) as protocol.LocalThread[];
  assert.deepEqual(pending.map((t) => t.id).sort(), [t1.id, 'n2'].sort(), 'a comment for GitHub does not wait for the agent');

  run(['reply', s.dir, t1.id], 'Because the handle is never closed.');
  run(['reply', s.dir, 'n2'], 'Yes.');
  assert.deepEqual(JSON.parse(run(['pending', s.dir])), []);
  assert.deepEqual(s.shown().find((t) => t.id === t1.id)?.comments.map((c) => `${c.author}:${c.body}`),
    ['agent:🟠 **should-fix** — leaks.', 'user:why?', 'agent:Because the handle is never closed.']);
  assert.equal(run(['fold', s.dir]).trim(), 'folded 0', 'a second sync with nothing new changes nothing');

  // "ok" needs no answer: an ack takes the thread off the list until the reviewer writes again.
  s.say({ type: 'comment', id: 'c4', thread: t1.id, to: 'agent', body: 'ok' });
  run(['fold', s.dir]);
  assert.deepEqual((JSON.parse(run(['pending', s.dir])) as protocol.LocalThread[]).map((t) => t.id), [t1.id]);
  run(['ack', s.dir, t1.id]);
  assert.deepEqual(JSON.parse(run(['pending', s.dir])), []);
  s.say({ type: 'comment', id: 'c5', thread: t1.id, to: 'agent', body: 'one more thing' });
  run(['fold', s.dir]);
  assert.equal((JSON.parse(run(['pending', s.dir])) as unknown[]).length, 1, 'a new comment makes it pending again');

  // A hypothesis confirmed: the answer is a finding, the earlier answers were replies.
  run(['reply', s.dir, 'n2', '--finding'], '🟠 **should-fix** — not safe after all.');
  const kinds = (s.file().threads.find((t) => t.id === 'n2')?.comments ?? []).map((c) => (c as { kind?: string }).kind ?? c.author);
  assert.deepEqual(kinds, ['user', 'reply', 'finding']);
  assert.equal((s.file().threads[0]?.comments[0] as { kind?: string }).kind, 'finding', 'findings from add are findings');
});

test('threads.sh: edits, deletes, drops and states', () => {
  const s = scratch();
  const batch = path.join(s.dir, 'batch.json');
  fs.writeFileSync(batch, JSON.stringify({ comments: [{ path: 'a.ts', line: 1, body: 'one' }, { path: 'a.ts', line: 2, body: 'two' }] }));
  run(['add', s.dir, batch]);
  const [t1, t2] = s.shown();
  assert.ok(t1 && t2);
  s.say({ type: 'comment', id: 'c1', thread: 'n1', to: 'github', body: 'mine', anchor: { path: 'b.ts', line: 5, side: 'RIGHT' } });
  s.say({ type: 'comment', id: 'c2', thread: 'n2', to: 'agent', body: 'oops', anchor: { path: 'b.ts', line: 6, side: 'RIGHT' } });
  run(['fold', s.dir]);
  s.say({ type: 'edit', comment: 'c1', body: 'mine, reworded' });
  s.say({ type: 'delete', comment: 'c2' });
  s.say({ type: 'drop', thread: t2.id });
  s.say({ type: 'edit', comment: t1.comments[0]?.id, body: 'hijack' });
  run(['fold', s.dir]);
  assert.deepEqual(s.shown().map((t) => [t.id, t.comments.map((c) => c.body)]), [[t1.id, ['one']], ['n1', ['mine, reworded']]],
    "the reviewer's edit is applied, an emptied thread and a dropped one are gone, the agent's comment is untouched");
  assert.deepEqual(JSON.parse(run(['list', s.dir])).map((t: protocol.LocalThread) => t.id), [t1.id, 'n1']);

  run(['edit', s.dir, t1.comments[0]?.id ?? ''], 'one, shorter');
  run(['state', s.dir, 'n1', 'published']);
  assert.deepEqual(s.shown().map((t) => [t.comments[0]?.body, t.state]), [['one, shorter', 'open'], ['mine, reworded', 'published']]);

  assert.equal(code(['edit', s.dir, 'c1'], 'x'), 4, "the reviewer's comment cannot be edited by the agent");
  assert.equal(code(['reply', s.dir, 'nope'], 'x'), 4);
  assert.equal(code(['state', s.dir, t1.id, 'bogus']), 4);
  fs.writeFileSync(batch, JSON.stringify({ comments: [] }));
  assert.equal(code(['add', s.dir, batch]), 5);
  assert.equal(code(['list', path.join(s.dir, 'missing')]), 4);
});

test('threads.sh wait: the listener behind the Sync button', async () => {
  const s = scratch();
  const pidfile = path.join(s.dir, 'wait.pid');
  const until = async (ok: () => boolean): Promise<void> => { for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 50)); };
  const listen = (): { out: () => string; done: Promise<number | null> } => {
    const child = spawn('bash', [SCRIPT, 'wait', s.dir]);
    let out = '';
    child.stdout.on('data', (d) => { out += String(d); });
    return { out: () => out.trim(), done: new Promise((r) => child.on('close', r)) };
  };

  const first = listen();
  await until(() => fs.existsSync(pidfile));
  assert.ok(fs.existsSync(pidfile), 'the extension sees a live listener through wait.pid');
  assert.doesNotThrow(() => process.kill(Number(fs.readFileSync(pidfile, 'utf8')), 0));
  assert.equal(code(['wait', s.dir]), 6, 'only one listener per review');

  fs.writeFileSync(path.join(s.dir, 'sync.request'), 'now\n');
  assert.equal(await first.done, 0);
  assert.equal(first.out(), 'SYNC');
  assert.equal(fs.existsSync(path.join(s.dir, 'sync.request')), false, 'the request is consumed');
  assert.equal(fs.existsSync(pidfile), false, 'no stale pid is left');

  const third = listen();
  await until(() => fs.existsSync(pidfile));
  fs.writeFileSync(path.join(s.dir, 'sync.request'), 'draft 2026-11-23T10:00:00.000Z\n');
  assert.equal(await third.done, 0);
  assert.equal(third.out(), 'DRAFT', 'the same file asks for a draft');

  const second = listen();
  await until(() => fs.existsSync(pidfile));
  fs.rmSync(s.dir, { recursive: true, force: true });
  assert.equal(await second.done, 0);
  assert.equal(second.out(), 'GONE', 'removing the review ends the listener');
});

test('publish.sh: what goes to the GitHub draft and where', () => {
  const PUBLISH = path.join(path.dirname(SCRIPT), 'publish.sh');
  const s = scratch();
  const agent = (id: string, kind: string, body: string) => ({ id, author: 'agent', kind, body });
  const user = (id: string, to: string, body: string) => ({ id, author: 'user', to, body });
  fs.writeFileSync(path.join(s.dir, 'threads.json'), JSON.stringify({ version: 1, cursor: 0, threads: [
    { id: 't1', path: 'src/a.ts', line: 11, side: 'RIGHT', state: 'open', comments: [
      agent('a1', 'finding', 'leaks'), user('u1', 'agent', 'why?'), agent('a2', 'reply', 'because'), user('u2', 'github', 'Agree.')] },
    { id: 't2', path: 'src/a.ts', line: 200, side: 'RIGHT', state: 'open', comments: [agent('a3', 'finding', 'far away')] },
    { id: 't3', path: 'src/other.ts', line: 5, side: 'RIGHT', state: 'open', comments: [agent('a4', 'finding', 'outside')] },
    { id: 't4', path: 'src/a.ts', line: 3, side: 'LEFT', state: 'open', comments: [user('u3', 'github', 'Why removed?')] },
    { id: 't5', path: 'src/a.ts', line: 12, side: 'RIGHT', state: 'open', comments: [user('u4', 'agent', 'a question'), agent('a5', 'reply', 'an answer')] },
    { id: 't6', path: 'src/a.ts', line: 10, side: 'RIGHT', state: 'published',
      github: { thread: 'GT6', comments: { a6: { id: 'GC6', body: '🤖 **AI generated**\n\nold' }, u9: { id: 'GC9', body: 'gone' }, u8: { id: 'GC8', body: 'same' } } },
      comments: [agent('a6', 'finding', 'new'), user('u8', 'github', 'same'), user('u7', 'github', 'later')] },
    { id: 't7', path: 'src/a.ts', line: 10, side: 'RIGHT', state: 'dropped', github: { thread: 'GT7', comments: { a7: { id: 'GC7', body: 'x' } } }, comments: [agent('a7', 'finding', 'x')] },
  ] }));
  fs.writeFileSync(path.join(s.dir, 'pr.url'), 'https://github.com/o/r/pull/7\n');
  const files = path.join(s.dir, 'files.ndjson');
  fs.writeFileSync(files, `${JSON.stringify({ filename: 'src/a.ts', patch: '@@ -1,5 +9,5 @@\n ctx\n-two\n-three\n+added\n+added2\n ctx2' })}\n`);
  const plan = JSON.parse(execFileSync('bash', [PUBLISH, s.dir, '--dry-run', '--files', files], { encoding: 'utf8' })) as
    { op: string; tid: string; cid: string; to?: string; side?: string; body?: string }[];
  assert.deepEqual(plan.map((p) => [p.op, p.tid, p.cid, p.to ?? '']), [
    ['thread', 't1', 'a1', 'line'],   // a finding on a line of the diff
    ['reply', 't1', 'u2', ''],        // the reviewer's own comment in the same thread; the talk with the agent is left out
    ['thread', 't2', 'a3', 'file'],   // a line outside the diff: file-level
    ['thread', 't3', 'a4', 'skip'],   // a file outside the diff: nowhere to put it
    ['thread', 't4', 'u3', 'line'],   // a removed line, on the old side
    ['edit', 't6', 'a6', ''],         // already published and changed since
    ['reply', 't6', 'u7', ''],        // added after publishing
    ['delete', 't6', 'u9', ''],       // deleted after publishing
    ['delete', 't7', 'a7', ''],       // a dropped thread leaves the draft
  ], 'a thread with only talk (t5) and an unchanged comment (u8) produce nothing');
  assert.equal(plan[0]?.body, '🤖 **AI generated**\n\nleaks', "the agent's findings carry the AI marker");
  assert.equal(plan[1]?.body, 'Agree.', "the reviewer's comment goes word for word");
  assert.equal(plan[2]?.body, '🤖 **AI generated**\n\n`src/a.ts:200`\n\nfar away');
  assert.equal(plan[4]?.side, 'LEFT');
  assert.equal(spawnSync('bash', [PUBLISH, path.join(s.dir, 'missing')]).status, 2);
});

test('a reply in a thread that lives on GitHub: from the panel to the draft', () => {
  const PUBLISH = path.join(path.dirname(SCRIPT), 'publish.sh');
  const s = scratch();
  const anchor = { path: 'src/a.ts', line: 10, side: 'RIGHT' };
  // The first local comment in a GitHub thread says where the thread is and which one it is.
  s.say({ type: 'comment', id: 'u1', thread: 'gh:GT1', to: 'agent', body: 'is the author right?', anchor, github: { thread: 'GT1' } });
  assert.deepEqual(s.shown().map((t) => [t.id, t.github?.thread]), [['gh:GT1', 'GT1']], 'the panel shows it before a sync');
  run(['fold', s.dir]);
  assert.deepEqual(s.file().threads.map((t) => [t.id, t.path, t.line, t.github]), [['gh:GT1', 'src/a.ts', 10, { thread: 'GT1', comments: {} }]]);
  assert.equal((JSON.parse(run(['pending', s.dir])) as unknown[]).length, 1, 'a question about a GitHub thread waits for the agent');
  run(['reply', s.dir, 'gh:GT1'], 'yes');
  s.say({ type: 'comment', id: 'u2', thread: 'gh:GT1', to: 'github', body: 'Agreed, thanks.' });
  run(['fold', s.dir]);
  fs.writeFileSync(path.join(s.dir, 'pr.url'), 'https://github.com/o/r/pull/7\n');
  const files = path.join(s.dir, 'files.ndjson');
  fs.writeFileSync(files, '');
  const plan = (): string[][] => (JSON.parse(execFileSync('bash', [PUBLISH, s.dir, '--dry-run', '--files', files], { encoding: 'utf8' })) as
    { op: string; tid: string; cid: string; body?: string }[]).map((p) => [p.op, p.tid, p.cid, p.body ?? '']);
  assert.deepEqual(plan(), [['reply', 'gh:GT1', 'u2', 'Agreed, thanks.']], 'only the comment for GitHub goes, as a reply in that thread');

  // Clearing the draft drops the record; writing in the thread again starts it over.
  s.say({ type: 'drop', thread: 'gh:GT1' });
  run(['fold', s.dir]);
  assert.deepEqual(s.shown(), []);
  s.say({ type: 'comment', id: 'u3', thread: 'gh:GT1', to: 'github', body: 'Second try.', anchor, github: { thread: 'GT1' } });
  assert.deepEqual(s.shown().map((t) => t.comments.map((c) => c.id)), [['u3']]);
  run(['fold', s.dir]);
  assert.deepEqual(s.file().threads.map((t) => [t.id, t.state, t.comments.map((c) => c.id)]), [['gh:GT1', 'open', ['u3']]]);
  assert.deepEqual(plan(), [['reply', 'gh:GT1', 'u3', 'Second try.']]);
});

test('a task: one thread store for several worktrees', () => {
  const PUBLISH = path.join(path.dirname(SCRIPT), 'publish.sh');
  const s = scratch();
  const batch = path.join(s.dir, 'batch.json');
  // The agent's self-review notes: for the user only, in one unit's worktree.
  fs.writeFileSync(batch, JSON.stringify({ root: '/w/api', talk: true, comments: [{ path: 'src/a.ts', line: 5, body: 'a note' }] }));
  run(['add', s.dir, batch]);
  // The user: a comment on a line of the other unit, and a reply in a reviewer's thread of this one.
  s.say({ type: 'comment', id: 'u1', thread: 'n1', to: 'agent', body: 'rename it', anchor: { path: 'src/b.ts', line: 2, side: 'RIGHT', root: '/w/ui' } });
  s.say({ type: 'comment', id: 'u2', thread: 'gh:GT', to: 'github', body: 'Done.', anchor: { path: 'src/a.ts', line: 9, side: 'RIGHT', root: '/w/api' }, github: { thread: 'GT' } });
  assert.deepEqual(protocol.threadsOf(s.shown(), '/w/ui/').map((t) => t.id), ['n1'], 'a window shows the threads of its own worktree');
  run(['fold', s.dir]);
  const threads = s.file().threads;
  assert.deepEqual(threads.map((t) => [t.root, t.comments[0]?.author, (t.comments[0] as { kind?: string }).kind ?? '']),
    [['/w/api', 'agent', 'reply'], ['/w/ui', 'user', ''], ['/w/api', 'user', '']]);
  assert.deepEqual(protocol.threadsOf(s.shown(), '/w/api').length, 2);
  assert.deepEqual((JSON.parse(run(['pending', s.dir])) as { id: string; root: string }[]).map((t) => [t.id, t.root]), [['n1', '/w/ui']]);

  const files = path.join(s.dir, 'files.ndjson');
  fs.writeFileSync(files, '');
  const plan = (root: string): string[][] => (JSON.parse(execFileSync('bash', [PUBLISH, s.dir, '--allow-moved', '--dry-run', '--files', files],
    { encoding: 'utf8', env: { ...process.env, AJMO_PR_URL: 'https://github.com/o/r/pull/7', AJMO_ROOT: root } })) as
    { op: string; tid: string; cid: string }[]).map((p) => [p.op, p.tid, p.cid]);
  assert.deepEqual(plan('/w/api'), [['reply', 'gh:GT', 'u2']], "the note is talk and stays local; the reply goes to that unit's PR");
  assert.deepEqual(plan('/w/ui'), [], "nothing of another unit's goes to this PR");
});

test('threads.sh rebase: threads follow the code when the PR head moves', () => {
  const s = scratch();
  // A repository with the review worktree at <scratch>/head, as collect.sh makes it.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ajmo-repo-'));
  const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();
  const lines = (n: number, patch: Record<number, string> = {}): string => Array.from({ length: n }, (_, i) => patch[i + 1] ?? `line ${i + 1}`).join('\n') + '\n';
  git(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.ts'), lines(20));
  fs.writeFileSync(path.join(repo, 'old-name.ts'), lines(5));
  fs.writeFileSync(path.join(repo, 'gone.ts'), lines(3));
  git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'reviewed');
  const first = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'worktree', 'add', '-q', '--detach', path.join(s.dir, 'head'), first);

  const batch = path.join(s.dir, 'batch.json');
  fs.writeFileSync(batch, JSON.stringify({ comments: [
    { path: 'a.ts', line: 2, body: 'above every change' },
    { path: 'a.ts', line: 10, body: 'on a line the push rewrites' },
    { path: 'a.ts', line: 15, body: 'below the changes' },
    { path: 'old-name.ts', line: 4, body: 'in a file the push renames' },
    { path: 'gone.ts', line: 1, body: 'in a file the push deletes' },
    { path: 'a.ts', line: 3, side: 'LEFT', body: 'on the base side' },
  ] }));
  run(['add', s.dir, batch]);
  assert.equal(s.file().head, first, 'the threads remember the commit their lines refer to');
  assert.equal(run(['rebase', s.dir]).trim(), 'nothing to rebase');

  // The author pushes: three lines inserted after line 5, line 10 rewritten, a rename and a delete.
  const body = lines(20, { 10: 'line 10, rewritten' }).split('\n');
  body.splice(5, 0, 'new A', 'new B', 'new C');
  fs.writeFileSync(path.join(repo, 'a.ts'), body.join('\n'));
  git(repo, 'mv', 'old-name.ts', 'new-name.ts');
  git(repo, 'rm', '-q', 'gone.ts');
  git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'push');
  const second = git(repo, 'rev-parse', 'HEAD');
  git(path.join(s.dir, 'head'), 'checkout', '-q', '--detach', second);

  const out = run(['rebase', s.dir]).trim().split('\n');
  assert.equal(out.at(-1), `rebased ${first} → ${second}`);
  const shown = s.shown().map((t) => [t.comments[0]?.body, t.path, t.line, t.outdated ?? false]);
  assert.deepEqual(shown, [
    ['above every change', 'a.ts', 2, false],
    ['on a line the push rewrites', 'a.ts', 13, true],
    ['below the changes', 'a.ts', 18, false],
    ['in a file the push renames', 'new-name.ts', 4, false],
    ['in a file the push deletes', 'gone.ts', 1, true],
    ['on the base side', 'a.ts', 3, false],
  ]);
  assert.equal(out.filter((l) => l.startsWith('outdated ')).length, 2);
  assert.equal(out.filter((l) => l.startsWith('moved ')).length, 2, 'the shifted line and the renamed file');
  assert.equal(s.file().head, second);
  assert.equal(run(['rebase', s.dir]).trim(), 'nothing to rebase', 'a second run changes nothing');

  // The agent looked again and the finding still applies, two lines lower.
  const stale = s.shown().find((t) => t.outdated && t.path === 'a.ts');
  run(['place', s.dir, stale?.id ?? '', '15']);
  assert.deepEqual(s.shown().filter((t) => t.outdated).map((t) => t.path), ['gone.ts']);
  assert.equal(s.shown().find((t) => t.id === stale?.id)?.line, 15);
});
