import test from 'node:test';
import assert from 'node:assert/strict';
import * as m from '../src/reviewModel.ts';

test('review window: PR checkout, changed files, review threads', () => {

  assert.deepEqual(m.parseNameStatus('M\tsrc/b.ts\nA\tsrc/a.ts\nD\told.md\nR087\tsrc/x.ts\tsrc/y.ts\n\n'), [
    { status: 'deleted', path: 'old.md' },
    { status: 'added', path: 'src/a.ts' },
    { status: 'modified', path: 'src/b.ts' },
    { status: 'renamed', path: 'src/y.ts', oldPath: 'src/x.ts' },
  ]);

  const node = (over: object) => ({ id: 'PRRT_1', isResolved: false, path: 'src/a.ts', line: 33, diffSide: 'RIGHT',
    comments: { nodes: [{ author: { login: 'reviewer' }, body: 'Why?', createdAt: '2026-11-20T10:00:00Z', state: 'SUBMITTED' }] }, ...over });
  const json = JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [
    node({}),
    node({ isResolved: true, diffSide: 'LEFT', line: 5,
      comments: { nodes: [{ author: null, body: 'old', createdAt: '', state: 'SUBMITTED' }, { author: { login: 'me' }, body: 'draft', createdAt: '', state: 'PENDING' }] } }),
    node({ line: null, originalLine: 12 }),
    node({ line: null, originalLine: null }),
    node({ comments: { nodes: [] } }),
  ] } } } } });
  const { threads, outdated } = m.parseReviewThreads(json);
  assert.equal(outdated, 1);
  assert.deepEqual(threads.map((t) => [t.path, t.line, t.side, t.resolved, t.outdated, t.comments.map((c) => `${c.author}${c.pending ? '*' : ''}`)]), [
    ['src/a.ts', 33, 'RIGHT', false, false, ['reviewer']],
    ['src/a.ts', 5, 'LEFT', true, false, ['ghost', 'me*']],
    ['src/a.ts', 12, 'RIGHT', false, true, ['reviewer']],
  ], 'an outdated thread sits on its original line; one with no line at all is dropped');
  assert.deepEqual(m.parseReviewThreads('oops'), { threads: [], outdated: 0 });

});

test('local review threads: the agent file plus the unsent inbox', () => {
  const agent = JSON.stringify({ version: 1, cursor: 1, threads: [
    { id: 't1', path: 'src/a.ts', line: 10, side: 'RIGHT', state: 'open', comments: [
      { id: 'a1', author: 'agent', body: 'This leaks.' }, { id: 'u0', author: 'user', to: 'agent', body: 'why?' }] },
    { id: 't2', path: 'src/b.ts', line: 3, side: 'RIGHT', state: 'published', comments: [{ id: 'a2', author: 'agent', body: 'Typo.' }] },
    { id: 't3', path: 'src/c.ts', line: 1, side: 'RIGHT', state: 'dropped', comments: [{ id: 'a3', author: 'agent', body: 'gone' }] },
  ] });
  const inbox = [
    { type: 'comment', id: 'u0', thread: 't1', to: 'agent', body: 'why?' },
    { type: 'comment', id: 'u1', thread: 't1', to: 'agent', body: 'shorter' },
    { type: 'comment', id: 'u2', thread: 'n1', to: 'github', body: 'Rename this.', anchor: { path: 'src/d.ts', line: 7, side: 'LEFT' } },
    { type: 'comment', id: 'u3', thread: 'n2', to: 'agent', body: 'check it', anchor: { path: 'src/e.ts', line: 2, side: 'RIGHT' } },
    { type: 'delete', comment: 'u3' },
    { type: 'comment', id: 'u4', thread: 'missing', to: 'agent', body: 'no anchor' },
    { type: 'edit', comment: 'u0', body: 'why exactly?' },
    { type: 'edit', comment: 'a2', body: 'hijacked' },
    { type: 'delete', comment: 'a1' },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n{torn';
  const threads = m.localThreads(agent, inbox);
  assert.deepEqual(threads.map((t) => [t.id, t.path, t.line, t.side, t.state, t.comments.map((c) => `${c.id}${c.unsent ? '*' : ''}`)]), [
    ['t1', 'src/a.ts', 10, 'RIGHT', 'open', ['a1', 'u0*', 'u1*']],
    ['t2', 'src/b.ts', 3, 'RIGHT', 'published', ['a2']],
    ['n1', 'src/d.ts', 7, 'LEFT', 'open', ['u2*']],
  ], 'lines before the cursor are already in the agent file; a deleted new thread disappears');
  assert.equal(threads[0]?.comments[1]?.body, 'why exactly?', 'an already synced comment can be edited and becomes unsent again');
  assert.equal(threads[1]?.comments[0]?.body, 'Typo.', "the agent's comments cannot be edited or deleted from the inbox");
  assert.equal(m.unsentCount(threads), 3);
  assert.deepEqual(threads.map((x) => m.summarize(x)), [
    { title: 'This leaks.', kind: 'finding', unsent: true, published: false },
    { title: 'Typo.', kind: 'finding', unsent: false, published: true },
    { title: 'Rename this.', kind: 'github', unsent: true, published: false },
  ]);
  assert.equal(m.summarize({ id: 'x', path: 'f', line: 1, side: 'RIGHT', state: 'open',
    comments: [{ id: 'c', author: 'user', to: 'agent', body: `\n  ${'y'.repeat(120)}\nsecond` }] }).title.length, 90);
  const dropped = m.localThreads(agent, `${inbox}\n${JSON.stringify({ type: 'drop', thread: 't2' })}\n${JSON.stringify({ type: 'drop', thread: 'n1' })}`);
  assert.deepEqual(dropped.map((x) => x.id), ['t1'], "drop removes a whole thread, the agent's or the user's");
  assert.deepEqual(m.localThreads('', ''), []);
  assert.equal(m.localThreads('', JSON.stringify({ type: 'comment', id: 'u', thread: 'n', to: 'agent', body: 'x', anchor: { path: 'f', line: 1, side: 'RIGHT' } })).length, 1,
    'works before the agent has written anything');
});

test('fileTree: changed files as compacted folders', () => {
  const f = (p: string): m.ChangedFile => ({ status: 'modified', path: p });
  const tree = m.fileTree([f('README.md'), f('src/components/lab/Suggest/Suggest.tsx'), f('src/components/lab/Suggest/__tests__/a.test.tsx'),
    f('src/components/lab/Suggest/__tests__/b.test.tsx'), f('src/index.ts'), f('docs/deep/only/file.md')]);
  const show = (d: m.FileTreeFolder, depth = 0): string[] => [
    ...d.folders.flatMap((x) => [`${'  '.repeat(depth)}${x.name}/ [${x.path}]`, ...show(x, depth + 1)]),
    ...d.files.map((x) => `${'  '.repeat(depth)}${x.path.split('/').pop()}`),
  ];
  assert.deepEqual(show(tree), [
    'docs/deep/only/ [docs/deep/only]',
    '  file.md',
    'src/ [src]',
    '  components/lab/Suggest/ [src/components/lab/Suggest]',
    '    __tests__/ [src/components/lab/Suggest/__tests__]',
    '      a.test.tsx',
    '      b.test.tsx',
    '    Suggest.tsx',
    '  index.ts',
    'README.md',
  ]);
  assert.deepEqual(m.fileTree([]), { name: '', path: '', folders: [], files: [] });
});

test('roleOf: reviewer for a review scratch, author for a task scratch', () => {
  assert.equal(m.roleOf('pr-2949'), 'reviewer');
  assert.equal(m.roleOf('task-proj-14196'), 'author');
  assert.equal(m.roleOf('head'), null);
});

test('mergeThread: a GitHub thread and its local record as one conversation', () => {
  const gh = { id: 'T', path: 'a.ts', line: 3, side: 'RIGHT' as const, resolved: false, outdated: false, comments: [
    { id: 'G1', author: 'me', body: 'finding as published', createdAt: '2026-11-20T10:05:00Z', pending: false },
    { id: 'G2', author: 'author', body: 'done', createdAt: '2026-11-21T09:00:00Z', pending: false },
    { id: 'G3', author: 'me', body: 'thanks', createdAt: '2026-11-22T09:00:00Z', pending: true },
  ] };
  const local: m.LocalThread = { id: 't1', path: 'a.ts', line: 3, side: 'RIGHT', state: 'published',
    github: { thread: 'T', comments: { a1: { id: 'G1' }, u2: { id: 'G3' }, u3: { id: 'G4' } } },
    comments: [
      { id: 'a1', author: 'agent', body: 'finding', at: '2026-11-20T10:00:00Z' },
      { id: 'u1', author: 'user', to: 'agent', body: 'why?', at: '2026-11-20T10:01:00.500Z' },
      { id: 'u2', author: 'user', to: 'github', body: 'thanks', at: '2026-11-22T08:59:00Z' },
      { id: 'u3', author: 'user', to: 'github', body: 'one more', at: '2026-11-22T09:30:00Z' },
      { id: 'u4', author: 'user', to: 'agent', body: 'is it fixed?', at: '2026-11-22T10:00:00Z', unsent: true },
    ] };
  const show = (list: m.ThreadComment[]) => list.map((c) => c.from === 'github' ? `gh:${c.comment.id}` : `${c.comment.id}:${c.published}`);
  assert.deepEqual(show(m.mergeThread(gh, local)), ['a1:submitted', 'u1:local', 'gh:G2', 'u2:draft', 'u3:draft', 'u4:local'],
    'a published local comment stands in for its GitHub copy; a copy the last fetch does not hold counts as a draft');
  assert.deepEqual(show(m.mergeThread(gh, undefined)), ['gh:G1', 'gh:G2', 'gh:G3'], 'a thread that is only on GitHub');
  assert.deepEqual(show(m.mergeThread(undefined, local)), ['a1:draft', 'u1:local', 'u2:draft', 'u3:draft', 'u4:local'], 'a local thread, GitHub not loaded');
  assert.deepEqual(m.mergeThread(undefined, undefined), []);
});
