import test from 'node:test';
import assert from 'node:assert/strict';
import * as m from '../src/model.ts';
import * as sk from '../src/skills.ts';
import type { Records, Session } from '../src/model.ts';

const NOW = 1795200000000;
const DAY = 86400000;

// Entries are shaped like real `claude agents --json --all` output.
const dead = (id: string, cwd: string, startedAt: number, name: string): Session => ({ id, cwd, kind: 'background', startedAt, sessionId: `${id}-full`, name, state: 'done' });
const SAMPLE: Session[] = [
  dead('31277856', '/u/gh/uikit', NOW - 28 * DAY, 'code-review uikit pr 2689'),
  dead('b418d642', '/u/gh/uikit', NOW - 2 * DAY, 'uikit-pr-2949 code review'),
  dead('c0774b9d', '/u/gh/charts', NOW - 3600000, 'gravity-charts-pr-853'),
  { pid: 97398, id: '70e4b7fa', cwd: '/u/gh/date-components', kind: 'background', startedAt: NOW - 6 * 3600000,
    sessionId: '70e4b7fa-full', name: 'Date time selection [EPIC]', status: 'idle', state: 'done' },
];

test('classify: real and documented values', () => {
  assert.equal(m.classify({ state: 'done' }), 'done');
  assert.equal(m.classify({ state: 'done', status: 'idle', pid: 1 }), 'done');
  assert.equal(m.classify({ state: 'blocked', waitingFor: 'permission prompt' }), 'waiting');
  assert.equal(m.classify({ status: 'waiting' }), 'waiting');
  assert.equal(m.classify({ status: 'busy', state: 'done' }), 'done', 'the agent is done; only a background shell of the session still runs');
  assert.equal(m.classify({ status: 'busy' }), 'working', 'no state (an interactive session): the process status decides');
  assert.equal(m.classify({ state: 'working' }), 'working');
  assert.equal(m.classify({ state: 'failed' }), 'failed');
  assert.equal(m.classify({ state: 'stopped' }), 'stopped');
  assert.equal(m.classify({ state: 'something-new' }), 'unknown');
});

test('repoOf: a plain folder and worktrees', () => {
  assert.equal(m.repoOf('/Users/a/gh/uikit'), 'uikit');
  assert.equal(m.repoOf('/Users/a/gh/uikit/'), 'uikit');
  assert.equal(m.repoOf('/Users/a/gh/uikit.worktrees/abc-123-fix'), 'uikit');
  assert.equal(m.repoOf('/Users/a/gh/date-components/.claude/worktrees/t-20261120-time-picker'), 'date-components');
  assert.equal(m.repoOf('/Users/a/gh/date-components/.claude/worktrees/t-1/src'), 'date-components');
  assert.equal(m.repoOf(undefined), '(no folder)');
});

test('track: the first poll marks nothing unseen and stays quiet', () => {
  const { records, events } = m.track(null, SAMPLE, NOW);
  assert.equal(events.length, 0);
  assert.equal(Object.keys(records).length, 4);
  assert.ok(Object.values(records).every((r) => r.seen === true && r.changedAt === null));
});

test('track: transitions emit events, working does not', () => {
  const first = m.track(null, SAMPLE, NOW).records;
  const busy = SAMPLE.map((s) => (s.id === '70e4b7fa' ? { ...s, status: 'busy', state: 'working' } : s));
  const a = m.track(first, busy, NOW + 1000);
  assert.equal(a.events.length, 0);
  assert.equal(a.records['70e4b7fa-full']?.cls, 'working');

  const blocked = SAMPLE.map((s) => (s.id === '70e4b7fa' ? { ...s, status: 'waiting', state: 'blocked', waitingFor: 'input needed' } : s));
  const b = m.track(a.records, blocked, NOW + 2000);
  assert.deepEqual(b.events.map((e) => e.cls), ['waiting']);

  const c = m.track(b.records, SAMPLE, NOW + 3000);
  assert.deepEqual(c.events.map((e) => e.cls), ['done']);
  assert.equal(c.records['70e4b7fa-full']?.seen, false);
  assert.equal(c.records['70e4b7fa-full']?.changedAt, NOW + 3000);

  const d = m.track(c.records, SAMPLE, NOW + 4000);
  assert.equal(d.events.length, 0, 'a repeated poll without changes is quiet');
  assert.equal(d.records['70e4b7fa-full']?.seen, false, 'unseen stays unseen');
});

test('track: a new session after the first poll; vanished sessions are forgotten', () => {
  const first = m.track(null, SAMPLE, NOW).records;
  const added = [...SAMPLE, { id: 'new1', sessionId: 'new1-full', cwd: '/u/gh/uikit', state: 'blocked', waitingFor: 'permission prompt', pid: 5, startedAt: NOW }];
  const a = m.track(first, added, NOW + 1000);
  assert.deepEqual(a.events.map((e) => e.session.id), ['new1']);
  const b = m.track(a.records, SAMPLE.slice(0, 1), NOW + 2000);
  assert.deepEqual(Object.keys(b.records), ['31277856-full']);
});

test('buildGroups: shows every session, old ones included', () => {
  const records = m.track(null, SAMPLE, NOW).records;
  const v = m.buildGroups(SAMPLE, records);
  assert.deepEqual(v.groups.map((g) => g.repo), ['charts', 'date-components', 'uikit']);
  assert.deepEqual(v.groups[2]?.items.map((i) => i.session.id), ['b418d642', '31277856'], 'a 28-day-old finished session stays');
  assert.deepEqual([v.total, v.shown, v.filtered], [4, 4, 0]);
});

test('buildGroups: static order whatever the statuses, counters', () => {
  const list: Session[] = [
    ...SAMPLE,
    { id: 'w1', sessionId: 'w1', cwd: '/u/gh/uikit.worktrees/abc-1', state: 'blocked', waitingFor: 'input needed', pid: 2, startedAt: NOW - 1000, name: 'abc-1' },
    { id: 'r1', sessionId: 'r1', cwd: '/u/gh/uikit', status: 'busy', state: 'working', pid: 3, startedAt: NOW - 500, name: 'run' },
  ];
  let records = m.track(null, SAMPLE, NOW).records;
  records = m.track(records, list, NOW + 1).records;
  records['c0774b9d-full'] = { cls: 'done', changedAt: NOW, seen: false };
  const v = m.buildGroups(list, records);
  const order = (view: m.View) => view.groups.map((g) => [g.repo, ...g.items.map((i) => i.session.id)]);
  const expected = [
    ['charts', 'c0774b9d'],
    ['date-components', '70e4b7fa'],
    ['uikit', 'r1', 'w1', 'b418d642', '31277856'],
  ];
  assert.deepEqual(order(v), expected, 'repositories by name, sessions newest first');
  assert.deepEqual(v.counts, { waiting: 1, failed: 0, unseen: 1, working: 1 });
  assert.equal(v.groups[2]?.attention, 1);

  // Every session changes state and gets seen: nothing moves.
  const flipped = list.map((s): Session => (s.state === 'blocked' ? { ...s, state: 'done', waitingFor: undefined }
    : { ...s, status: 'waiting', state: 'blocked', waitingFor: 'input needed' }));
  const later = m.track(records, flipped, NOW + 2).records;
  for (const key of Object.keys(later)) m.markSeen(later, key);
  assert.deepEqual(order(m.buildGroups(flipped, later)), expected);
});

test('markSeen, labels', () => {
  const records: Records = { a: { cls: 'done', changedAt: NOW, seen: false } };
  assert.equal(m.markSeen(records, 'a'), true);
  assert.equal(m.markSeen(records, 'a'), false);
  assert.equal(m.markSeen(records, 'zzz'), false);
  assert.equal(m.statusLabel({ cls: 'waiting', session: { waitingFor: 'permission prompt' } }), 'permission');
  assert.equal(m.statusLabel({ cls: 'waiting', session: {} }), 'waiting for you');
  assert.equal(m.statusLabel({ cls: 'done', seen: false, session: {} }), 'done, unseen');
  assert.equal(m.timeLabel({ changedAt: NOW - 5 * 60000, session: {} }, NOW), '5 min');
  assert.equal(m.timeLabel({ changedAt: null, session: { startedAt: NOW - 2 * DAY } }, NOW), 'started 2 d ago');
  assert.equal(m.timeLabel({ changedAt: null, session: { startedAt: NOW - 5000 } }, NOW), 'started just now');
});

// Entries captured from the live CLI 2.1.321 (2026-11-21).
const LIVE_BUSY: Session = { pid: 50716, id: '00075973', cwd: '/u/gh/charts', kind: 'background', startedAt: NOW - 1000,
  sessionId: '00075973-full', name: 'pr-643-diff-collection', status: 'busy', state: 'working' };
const LIVE_WAITING: Session = { ...LIVE_BUSY, status: 'waiting', waitingFor: 'input needed', state: 'blocked' };
const LIVE_INTERACTIVE: Session = { pid: 27622, cwd: '/u/pet/ajmo', kind: 'interactive', startedAt: NOW - 5000,
  sessionId: 'af4e5508-full', name: 'ajmo-84', status: 'idle' };

test('classify: values from live output', () => {
  assert.equal(m.classify(LIVE_BUSY), 'working');
  assert.equal(m.classify(LIVE_WAITING), 'waiting');
  assert.equal(m.statusLabel({ cls: 'waiting', session: LIVE_WAITING }), 'needs input');
  assert.equal(m.classify(LIVE_INTERACTIVE), 'done');
  assert.equal(m.classify({ ...LIVE_INTERACTIVE, status: 'busy' }), 'working');
});

test('interactive session: no id, keyed by sessionId, cannot attach', () => {
  assert.equal(m.sessionKey(LIVE_INTERACTIVE), 'af4e5508-full');
  assert.equal(m.canAttach(LIVE_INTERACTIVE), false);
  assert.equal(m.canAttach(LIVE_BUSY), true);
  assert.equal(m.canAttach({ id: 'a; rm -rf /' }), false);

  const first = m.track(null, [{ ...LIVE_INTERACTIVE, status: 'busy' }], NOW).records;
  const a = m.track(first, [LIVE_INTERACTIVE], NOW + 1000);
  assert.deepEqual(a.events.map((e) => e.cls), ['done']);
  const v = m.buildGroups([LIVE_INTERACTIVE], a.records);
  const item = v.groups[0]?.items[0];
  assert.ok(item);
  assert.equal(item.key, 'af4e5508-full');
  assert.equal(m.describe(item, NOW + 1000), 'done, unseen · interactive · just now');
  assert.equal(v.counts.unseen, 1);
});

test('findWindow: another window with the session folder', () => {
  const own = { pid: 1, target: 'file:///u/pet/panel', folders: ['/u/pet/panel'] };
  const uikit = { pid: 2, target: 'file:///u/gh/uikit', folders: ['/u/gh/uikit'] };
  const gh = { pid: 3, target: 'file:///u/gh.code-workspace', folders: ['/u/gh', '/u/other'] };
  const noTarget = { pid: 4, target: null, folders: ['/u/gh/charts', '/u/gh/chartkit'] };
  const all = [own, uikit, gh, noTarget];
  assert.equal(m.findWindow(all, '/u/gh/uikit', 1), uikit, 'the deepest folder');
  assert.equal(m.findWindow(all, '/u/gh/uikit/src', 1), uikit, 'a nested folder');
  assert.equal(m.findWindow(all, '/u/gh/uikit-extra', 1), gh, 'a shared name prefix is not nesting');
  assert.equal(m.findWindow(all, '/u/gh/charts', 1), gh, 'a window without a target does not qualify');
  assert.equal(m.findWindow(all, '/u/pet/panel', 1), null, 'own window');
  assert.equal(m.findWindow(all, '/u/elsewhere', 1), null);
  assert.equal(m.findWindow(all, undefined, 1), null);
});

test('ownerWindow: the window by the session process ancestry', () => {
  const { parents } = m.parsePs('  68656 67123 claude --output-format stream-json\n67123 39736\n39736     1 /Applications/Code\n  500   400\n  400   500\ngarbage\n');
  assert.equal(parents.get(68656), 67123);
  const own = { pid: 67123, target: 'file:///u/pet/panel', folders: ['/u/pet/panel'] };
  const other = { pid: 400, target: 'file:///u/gh/uikit', folders: ['/u/gh/uikit'] };
  assert.equal(m.ownerWindow([own, other], 68656, parents), own, 'live example: claude descends from the extension host');
  assert.equal(m.ownerWindow([other], 68656, parents), null, 'a session from a terminal');
  assert.equal(m.ownerWindow([own], 500, parents), null, 'a cycle in the table does not loop forever');
  assert.equal(m.ownerWindow([own], undefined, parents), null);
});

test('filter and the flat list for search', () => {
  const list: Session[] = [...SAMPLE, LIVE_WAITING, { ...LIVE_INTERACTIVE, status: 'busy' }];
  const records = m.track(null, list, NOW).records;
  records['c0774b9d-full'] = { cls: 'done', changedAt: NOW, seen: false };
  const ids = (v: ReturnType<typeof m.buildGroups>) => m.flatten(v).map((i) => i.session.id ?? i.key);

  const all = m.buildGroups(list, records, { mode: 'all' });
  assert.deepEqual(ids(all), ['00075973', 'c0774b9d', 'af4e5508-full', '70e4b7fa', 'b418d642', '31277856']);
  assert.equal(m.flatten(all)[0]?.repo, 'charts');
  assert.equal(all.filtered, 0);

  const attention = m.buildGroups(list, records, { mode: 'attention' });
  assert.deepEqual(ids(attention), ['00075973', 'c0774b9d']);
  assert.equal(attention.filtered, 4);
  assert.deepEqual(attention.counts, all.counts, 'counters do not depend on the filter');

  const working = m.buildGroups(list, records, { mode: 'working' });
  assert.deepEqual(ids(working), ['af4e5508-full'], 'idle with a live process is not working');
});

test('search query, filter flag, modes', () => {
  const list: Session[] = [...SAMPLE, LIVE_WAITING];
  const records = m.track(null, list, NOW).records;
  const ids = (filter: Partial<m.FilterState>) => m.flatten(m.buildGroups(list, records, filter)).map((i) => i.session.id);

  assert.deepEqual(ids({ query: 'charts' }), ['00075973', 'c0774b9d'], 'by repository');
  assert.deepEqual(ids({ query: 'charts', mode: 'attention' }), ['00075973']);
  assert.deepEqual(ids({ query: 'UIKIT' }), ['b418d642', '31277856'], 'old sessions included');
  assert.deepEqual(ids({ query: 'pr  uikit 2949' }), ['b418d642'], 'all words, any order');
  assert.deepEqual(ids({ query: 'needs input' }), ['00075973'], 'by status label');
  assert.deepEqual(ids({ query: '70e4' }), ['70e4b7fa'], 'by id');
  assert.deepEqual(ids({ query: 'no such thing' }), []);

  const v = m.buildGroups(list, records, { mode: 'working' });
  assert.deepEqual([v.total, v.shown, v.filtered], [5, 0, 5]);

  assert.equal(m.filterActive(m.NO_FILTER), false);
  assert.equal(m.filterActive({ ...m.NO_FILTER, mode: 'working' }), true);
  assert.equal(m.filterActive({ ...m.NO_FILTER, query: '  ' }), false);
  assert.equal(m.filterActive({ ...m.NO_FILTER, query: 'x' }), true);

  const f = m.modeFacets(list, records);
  assert.deepEqual(f.map((x) => [x.id, x.label, x.count]),
    [['all', 'All', 5], ['attention', 'Needs attention', 1], ['working', 'Working', 0]]);
});

test('activeSessionKey: the active tab session', () => {
  const chat2: Session = { ...LIVE_INTERACTIVE, sessionId: 'chat2-full', name: 'second chat' };
  const list: Session[] = [...SAMPLE, LIVE_BUSY, LIVE_INTERACTIVE, chat2];
  const none = new Set<string>();
  assert.equal(m.activeSessionKey(list, { kind: 'terminal', label: 'anything', sessionKey: '00075973-full' }, none), '00075973-full');
  assert.equal(m.activeSessionKey(list, { kind: 'terminal', label: 'charts #643' }, none), null, 'the tab name is no evidence');
  assert.equal(m.activeSessionKey(list, { kind: 'terminal', label: 'zsh', sessionKey: 'vanished' }, none), null);
  assert.equal(m.activeSessionKey(list, null, none), null);

  const one = new Set(['af4e5508-full']);
  assert.equal(m.activeSessionKey(list, { kind: 'chat', label: 'any title' }, one), 'af4e5508-full', 'the only chat of the window');
  const two = new Set(['af4e5508-full', 'chat2-full']);
  assert.equal(m.activeSessionKey(list, { kind: 'chat', label: 'any title' }, two), null, 'two chats — no guessing');
  assert.equal(m.activeSessionKey(list, { kind: 'chat', label: 'second chat' }, two), 'chat2-full', 'by matching name');
  assert.equal(m.activeSessionKey(list, { kind: 'chat', label: 'x' }, none), null, 'a chat from another window');
});

test('terminalSessionKey: the terminal session by processes', () => {
  // Live example: terminal shell 42355 runs `claude attach 93b2eb9b`.
  const procs = m.parsePs([
    '42355 39736 /bin/zsh -il',
    '42825 42355 claude attach 93b2eb9b',
    '60000 39736 /bin/zsh -il',
    '60001 60000 /Users/a/.local/bin/claude attach uikit-pr-2949',
    '70000 39736 /bin/zsh -il',
    '27622 70000 claude',
    '80000 39736 /bin/zsh -il',
    '80001 80000 vim attach.txt',
  ].join('\n'));
  assert.deepEqual(procs.attaches, [{ pid: 42825, target: '93b2eb9b' }, { pid: 60001, target: 'uikit-pr-2949' }]);
  const attached: Session = { id: '93b2eb9b', sessionId: '93b2eb9b-full', name: 'charts-pr-849 diff', kind: 'background', state: 'done' };
  const list: Session[] = [...SAMPLE, attached, LIVE_INTERACTIVE];
  assert.equal(m.terminalSessionKey(list, 42355, procs), '93b2eb9b-full', 'attach by id');
  assert.equal(m.terminalSessionKey(list, 60000, procs), 'b418d642-full', 'attach by a part of the name');
  assert.equal(m.terminalSessionKey(list, 70000, procs), 'af4e5508-full', 'an interactive session in a terminal');
  assert.equal(m.terminalSessionKey(list, 80000, procs), null, 'a plain terminal');
  assert.equal(m.terminalSessionKey(list, undefined, procs), null);
  assert.equal(m.activeSessionKey(list, { kind: 'terminal', label: 'charts-pr-849', sessionKey: '93b2eb9b-full' }, new Set()), '93b2eb9b-full');
});

test('terminalRename: give a session terminal its name back', () => {
  assert.equal(m.terminalRename(LIVE_BUSY, 'pr-643'), 'charts #643');
  assert.equal(m.terminalRename(LIVE_BUSY, 'charts #643'), null, 'already named');
  assert.equal(m.terminalRename(LIVE_INTERACTIVE, 'zsh'), null, 'an interactive session in a terminal is left alone');
  assert.equal(m.terminalRename(undefined, 'zsh'), null);
});

test('terminalLabel: short tab name (session names from the live machine)', () => {
  const label = (name: string, cwd: string) => m.terminalLabel({ id: 'x', name, cwd });
  assert.equal(label('code-review gravity-ui uikit pr 2689', '/u/gh/uikit'), 'uikit #2689');
  assert.equal(label('pull request 2781 review', '/u/gh/uikit'), 'uikit #2781');
  assert.equal(label('uikit-pr-2949 code review', '/u/gh/uikit'), 'uikit #2949');
  assert.equal(label('chartkit pr 968 review', '/u/gh/chartkit'), 'chartkit #968');
  assert.equal(label('gravity-charts-pr-853', '/u/gh/charts'), 'charts #853');
  assert.equal(label('pr-643-diff-collection', '/u/gh/charts'), 'charts #643');
  assert.equal(label('code-review acme-app pr 2718', '/u/gh/acme-app'), 'acme-app #2718');
  assert.equal(label('proj-13554 ticket review', '/u/gh/acme-app'), 'PROJ-13554');
  assert.equal(label('proj-14196 form mocks metadata', '/u/gh/acme-app'), 'PROJ-14196');
  assert.equal(label('Date time selection [EPIC]', '/u/gh/date-components'), 'Date time selection [EPIC]');
  assert.equal(label('enable-mix-entry-reads-flag', '/u/gh/acme-flags'), 'enable-mix-entry-reads-flag');
  assert.equal(label('time-selection-component', '/u/gh/date-components/.claude/worktrees/t-20261120-time-picker'), 'time-selection-component');
  assert.equal(label('express v5 upgrade', '/u/gh/x'), 'express v5 upgrade', 'short numbers are not a ticket');
  assert.equal(m.terminalLabel({ id: 'x' }), 'claude');
});

test('new session: where it can start', () => {
  assert.equal(m.launchDir('', '/u/gh/uikit', true, '/u'), '/u/gh', 'a repository: its parent, so siblings are offered');
  assert.equal(m.launchDir('', '/u/gh', false, '/u'), '/u/gh', 'a folder of repositories: itself');
  assert.equal(m.launchDir('', undefined, false, '/u'), '/u');
  assert.equal(m.launchDir(' ~/work ', '/u/gh/uikit', true, '/u'), '/u/work', 'the setting wins');
  assert.equal(m.launchDir('/abs/dir', undefined, false, '/u'), '/abs/dir');

  assert.equal(sk.repoRoot('/u/gh/date-components/.claude/worktrees/t-1/src'), '/u/gh/date-components');
  assert.equal(sk.repoRoot('/u/gh/uikit.worktrees/abc-1'), '/u/gh/uikit');
  assert.equal(sk.repoRoot('/u/gh/charts/'), '/u/gh/charts');

  const sessions: Session[] = [
    ...SAMPLE,
    { id: 'w', cwd: '/u/gh/uikit.worktrees/abc-1' },
    { id: 'p', cwd: '/u/pet/panel' },
    { id: 'n' },
  ];
  assert.deepEqual(m.repoChoices(['/u/gh/aikit', '/u/gh/uikit/'], sessions), [
    { name: 'aikit', dir: '/u/gh/aikit' },
    { name: 'charts', dir: '/u/gh/charts' },
    { name: 'date-components', dir: '/u/gh/date-components' },
    { name: 'panel', dir: '/u/pet/panel' },
    { name: 'uikit', dir: '/u/gh/uikit' },
  ], 'child repositories and repositories with sessions, no duplicates');

  assert.equal(m.startedSessionId('Started background session 0a1b2c3d\n'), '0a1b2c3d');
  assert.equal(m.startedSessionId('nothing here'), null);
});

test('skills: frontmatter, commands, suggestions', () => {
  const task = ['---', 'name: task', 'description: >-', "  Takes one of the user's own tasks — a tracker key or plain text —", '  to a merged PR: plans it. The user is the PR author.',
    'disable-model-invocation: true', '---', '', '# Task'].join('\n');
  assert.deepEqual(m.parseSkill(task, 'dir', 'korvin89'), {
    command: '/korvin89:task',
    description: "Takes one of the user's own tasks — a tracker key or plain text — to a merged PR: plans it. The user is the PR author.",
  });
  const quoted = '---\nname: gravity-ui-v8-migration\ndescription: "Upgrades uikit from v7 to v8. Use when bumping."\n---\n';
  assert.deepEqual(m.parseSkill(quoted, 'x'), { command: '/gravity-ui-v8-migration', description: 'Upgrades uikit from v7 to v8. Use when bumping.' });
  assert.deepEqual(m.parseSkill('no frontmatter', 'deploy'), { command: '/deploy', description: '' }, 'a plain command file');
  assert.equal(m.parseSkill('---\nname: inner\nuser-invocable: false\n---', 'inner'), null);

  const a = { command: '/b', description: 'user' };
  assert.deepEqual(m.sortSkills([a, { command: '/a:x', description: '' }, { command: '/b', description: 'plugin' }]),
    [{ command: '/a:x', description: '' }, a], 'sorted, the first duplicate wins');

  assert.equal(m.isPickingSkill('/'), true);
  assert.equal(m.isPickingSkill('/korvin89:ta'), true);
  assert.equal(m.isPickingSkill('/korvin89:task PROJ-1'), false);
  assert.equal(m.isPickingSkill('fix the bug'), false);
  assert.equal(m.isPickingSkill(''), false);

  assert.equal(m.brief('Upgrades uikit from v7 to v8. Use when bumping.'), 'Upgrades uikit from v7 to v8.');
  assert.equal(m.brief('a  b\n c'), 'a b c');
  assert.equal(m.brief('x'.repeat(200)).length, 110);
});

test('auto-seen helpers, next session needing attention', () => {
  const unseen: Session = { ...SAMPLE[2] as Session };
  const list: Session[] = [...SAMPLE, LIVE_WAITING, { ...LIVE_INTERACTIVE, status: 'busy' }];
  const records = m.track(null, list, NOW).records;
  records['c0774b9d-full'] = { cls: 'done', changedAt: NOW, seen: false };
  const next = (active: string | null) => m.nextAttention(list, records, active)?.id;
  assert.equal(next(null), '00075973', 'waiting before unseen');
  assert.equal(next('00075973-full'), 'c0774b9d', 'the one after the active');
  assert.equal(next('c0774b9d-full'), '00075973', 'wraps around');
  assert.equal(next('70e4b7fa-full'), '00075973', 'the active one is not in the queue');
  assert.equal(m.nextAttention(SAMPLE, m.track(null, SAMPLE, NOW).records, null), null);

  assert.equal(m.markSeen(records, m.sessionKey(unseen)), true);
  assert.equal(m.markUnseen(records, 'c0774b9d-full'), true);
  assert.equal(m.markUnseen(records, 'c0774b9d-full'), false, 'already unseen');
  assert.equal(m.markUnseen(records, '00075973-full'), false, 'only finished sessions');
});
