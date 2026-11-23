// skills.ts — conventions the panel relies on but does not own: where git
// worktrees live, what the `task` and `code-review` skills — the `ajmo`
// plugin's and `korvin89`'s — keep in `<repo>/.git/ajmo/` and
// `<repo>/.git/code-review/`, and how a PR is named and addressed. Pure, shared
// by the agents part and the review part.
import * as path from 'node:path';

// repoRoot — the main checkout a session folder belongs to: a worktree in
// `<repo>/.claude/worktrees/<name>` or `<repo>.worktrees/<branch>` maps to <repo>.
export function repoRoot(cwd: string): string {
  const dir = cwd.replace(/[\\/]+$/, '');
  const own = /^(.*?)[\\/]\.claude[\\/]worktrees[\\/]/.exec(dir + path.sep);
  if (own?.[1]) return own[1];
  const parent = path.dirname(dir);
  if (parent.endsWith('.worktrees')) return parent.slice(0, -'.worktrees'.length);
  return dir;
}

// prNumber — the PR number a session name mentions ("pr 2689", "uikit-pr-2949",
// "pull request 2781"), or null.
export function prNumber(name: string | undefined): number | null {
  const m = /\b(?:pr|pull[\s-]request)[\s-]*#?(\d+)\b/i.exec(name || '');
  return m ? Number(m[1]) : null;
}

// lockSessionId — the session id in a task `lock` file of the user's skills:
// "<session id> <claude pid> <epoch>".
export function lockSessionId(text: string): string | null {
  return /^\s*(\S+)/.exec(text)?.[1] ?? null;
}

// taskPrUrls — PR links recorded in a task.json of the user's `task` skill
// (`units[].pr` is a URL or null).
export function taskPrUrls(json: string): string[] {
  try {
    const units = (JSON.parse(json) as { units?: { pr?: unknown }[] }).units;
    if (!Array.isArray(units)) return [];
    return units.map((u) => u?.pr).filter((p): p is string => typeof p === 'string' && /^https?:\/\//.test(p));
  } catch { return []; }
}

export interface TaskWorktree {
  label: string;
  dir: string;
}

// taskWorktrees — worktrees of a task's units from a task.json of the user's
// `task` skill (`units[].worktree` is a path or null).
export function taskWorktrees(json: string): TaskWorktree[] {
  try {
    const units = (JSON.parse(json) as { units?: { slug?: unknown; branch?: unknown; worktree?: unknown }[] }).units;
    if (!Array.isArray(units)) return [];
    return units.flatMap((u) => (typeof u?.worktree === 'string' && u.worktree
      ? [{ label: String(u.slug || u.branch || path.basename(u.worktree)), dir: u.worktree }] : []));
  } catch { return []; }
}

// taskCleanup — what removing an `ajmo` task takes away: the worktrees of its
// units, and the local branches the task created itself (a branch the user
// had before, or one checked out elsewhere, is not the task's to delete).
// Remote branches and PRs are left alone.
export function taskCleanup(json: string): { worktrees: string[]; branches: string[] } {
  const out = { worktrees: [] as string[], branches: [] as string[] };
  try {
    const units = (JSON.parse(json) as { units?: { branch?: unknown; worktree?: unknown; created?: unknown; detached?: unknown }[] }).units;
    for (const u of Array.isArray(units) ? units : []) {
      if (typeof u?.worktree === 'string' && u.worktree) out.worktrees.push(u.worktree);
      if (typeof u?.branch === 'string' && u.branch && u.created === true && u.detached !== true) out.branches.push(u.branch);
    }
  } catch { /* not a task file */ }
  return out;
}

// prUrlFromRemote — a GitHub-style PR URL built from a git remote URL.
export function prUrlFromRemote(remote: string, n: number): string | null {
  const r = remote.trim().replace(/\.git$/, '');
  const m = /^(?:https?:\/\/|ssh:\/\/(?:[^@/]+@)?|[^@/]+@)([^/:]+)(?::\d+)?[/:](.+)$/.exec(r);
  return m ? `https://${m[1]}/${m[2]}/pull/${n}` : null;
}

// Folders under `<repo>/.git/` where the skills keep the files of a review
// (`pr-<n>`) or a task (`task-<key>`), in the order they are looked up: the `ajmo` plugin's own, then `korvin89`'s.
export const REVIEW_ROOTS = ['ajmo', 'code-review'] as const;

// prHeadFolder — a review checkout. `korvin89` keeps it in
// `<repo>/.git/code-review/pr-<n>/head`; `ajmo` in
// `<repo>/.git/ajmo/pr-<n>/<repo>-pr-<n>` (`head` in older reviews), so that
// the window opened on it has a telling name. Returns the PR number, or null.
export function prHeadFolder(folder: string): number | null {
  const m = /[\\/]\.git[\\/](?:code-review[\\/]pr-(\d+)[\\/]head|ajmo[\\/]pr-(\d+)[\\/][^\\/]+)[\\/]?$/.exec(folder);
  return m ? Number(m[1] ?? m[2]) : null;
}

// cleanupRequest — what `korvin89`'s cleanup.sh says when it wants a
// confirmation: "CONFIRM <code>" and one "- warning" line per finding (exit
// code 10). Returns null for any other output.
export function cleanupRequest(stdout: string): { code: string; warnings: string[] } | null {
  const lines = stdout.split('\n');
  const at = lines.findIndex((l) => /^CONFIRM \S+/.test(l));
  if (at < 0) return null;
  return {
    code: (lines[at] as string).slice('CONFIRM '.length).trim(),
    warnings: lines.slice(at + 1).filter((l) => l.startsWith('- ')).map((l) => l.slice(2).trim()),
  };
}

// prFolderNumber — the PR number in a scratch folder name `pr-<n>`, or null.
export function prFolderNumber(name: string): number | null {
  const m = /^pr-(\d+)$/.exec(name);
  return m ? Number(m[1]) : null;
}

// prRepo — owner and repository name from a PR URL.
export function prRepo(url: string): { owner: string; name: string; number: number } | null {
  const m = /^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url.trim());
  return m?.[1] && m[2] ? { owner: m[1], name: m[2], number: Number(m[3]) } : null;
}
