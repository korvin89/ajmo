import test from 'node:test';
import assert from 'node:assert/strict';
import * as sk from '../src/skills.ts';

test('PR links and task worktrees: number in the name, task files, remote URL', () => {
  assert.equal(sk.prNumber('code-review gravity-ui uikit pr 2689'), 2689);
  assert.equal(sk.prNumber('pull request 2781 review'), 2781);
  assert.equal(sk.prNumber('gravity-charts-pr-853'), 853);
  assert.equal(sk.prNumber('proj-14173 export streaming flag'), null);
  assert.equal(sk.prNumber(undefined), null);

  assert.equal(sk.lockSessionId('5f2ecd36-3504-4ce0-ad50-0e54434d43e9 2281 1795033154\n'), '5f2ecd36-3504-4ce0-ad50-0e54434d43e9');
  assert.equal(sk.lockSessionId(''), null);
  const task = JSON.stringify({ key: 'charts-1', units: [{ slug: 'a', pr: null }, { slug: 'b', pr: 'https://github.com/o/r/pull/3338' }, { pr: 12 }] });
  assert.deepEqual(sk.taskPrUrls(task), ['https://github.com/o/r/pull/3338']);
  assert.deepEqual(sk.taskPrUrls('not json'), []);
  assert.deepEqual(sk.taskPrUrls('{}'), []);

  const units = JSON.stringify({ units: [
    { slug: 'enable', branch: 'charts-1-enable', worktree: '/u/gh/flags.worktrees/charts-1-enable' },
    { slug: 'planned', branch: 'charts-1-later', worktree: null },
    { branch: 'charts-1-x', worktree: '/u/gh/flags.worktrees/charts-1-x' },
  ] });
  assert.deepEqual(sk.taskWorktrees(units), [
    { label: 'enable', dir: '/u/gh/flags.worktrees/charts-1-enable' },
    { label: 'charts-1-x', dir: '/u/gh/flags.worktrees/charts-1-x' },
  ], 'units without a worktree are skipped');
  assert.deepEqual(sk.taskWorktrees('nope'), []);

  assert.equal(sk.prUrlFromRemote('git@github.com:gravity-ui/date-components.git\n', 7), 'https://github.com/gravity-ui/date-components/pull/7');
  assert.equal(sk.prUrlFromRemote('https://github.com/gravity-ui/uikit', 2949), 'https://github.com/gravity-ui/uikit/pull/2949');
  assert.equal(sk.prUrlFromRemote('ssh://git@host.example:22/yc/flags.git', 1), 'https://host.example/yc/flags/pull/1');
  assert.equal(sk.prUrlFromRemote('/local/path', 1), null);

  assert.equal(sk.prHeadFolder('/u/gh/uikit/.git/code-review/pr-2949/head'), 2949);
  assert.equal(sk.prHeadFolder('/u/gh/uikit/.git/code-review/pr-2949/head/'), 2949);
  assert.equal(sk.prHeadFolder('/u/gh/uikit.worktrees/abc-1'), null);
  assert.equal(sk.prHeadFolder('/u/gh/uikit/.git/ajmo/pr-7/head'), 7, "the ajmo plugin's own folder");
  assert.equal(sk.prHeadFolder('/u/gh/uikit/.git/other/pr-7/head'), null);
  assert.equal(sk.prHeadFolder('/u/gh/charts/.git/ajmo/pr-845/charts-pr-845'), 845, 'the named checkout');
  assert.equal(sk.prHeadFolder('/u/gh/charts/.git/code-review/pr-845/artifacts'), null, 'only head/ in the korvin89 layout');
  assert.equal(sk.prHeadFolder('/u/gh/charts/.git/ajmo/pr-845/charts-pr-845/src'), null);
  assert.equal(sk.prFolderNumber('pr-2949'), 2949);
  assert.equal(sk.prFolderNumber('task-x'), null);
  assert.deepEqual(sk.prRepo('https://github.com/gravity-ui/uikit/pull/2949\n'), { owner: 'gravity-ui', name: 'uikit', number: 2949 });
  assert.equal(sk.prRepo('https://github.com/gravity-ui/uikit'), null);
});

test('cleanupRequest: the confirmation cleanup.sh asks for', () => {
  assert.deepEqual(sk.cleanupRequest('CONFIRM a1b2\n- head/ has uncommitted files\n- a watcher is still running\n'),
    { code: 'a1b2', warnings: ['head/ has uncommitted files', 'a watcher is still running'] });
  assert.equal(sk.cleanupRequest('removed pr-12\n'), null);
});

test('taskCleanup: what removing an ajmo task takes away', () => {
  const task = JSON.stringify({ units: [
    { slug: 'api', branch: 't-1-api', worktree: '/r.worktrees/t-1-api', created: true, detached: false },
    { slug: 'pr', branch: 'feature', worktree: '/r.worktrees/feature', created: false, detached: false },
    { slug: 'fork', branch: 'theirs', worktree: '/r.worktrees/theirs', created: true, detached: true },
    { slug: 'later', branch: 't-1-later', worktree: null, created: undefined },
  ] });
  assert.deepEqual(sk.taskCleanup(task), {
    worktrees: ['/r.worktrees/t-1-api', '/r.worktrees/feature', '/r.worktrees/theirs'],
    branches: ['t-1-api'],
  }, 'only a branch the task created itself, and not a detached one, is deleted');
  assert.deepEqual(sk.taskCleanup('nope'), { worktrees: [], branches: [] });
});
