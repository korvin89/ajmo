// reviewModel.ts — pure logic of the review part: changed files, GitHub review
// threads, and the local threads exchanged with the skills. No vscode.

export interface ChangedFile {
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  path: string;
  // The path at the base for a renamed file.
  oldPath?: string;
}

// parseNameStatus — `git diff --name-status -M` output.
export function parseNameStatus(text: string): ChangedFile[] {
  const out: ChangedFile[] = [];
  for (const line of text.split('\n')) {
    const [code, a, b] = line.split('\t');
    if (!code || !a) continue;
    if (code.startsWith('R') && b) out.push({ status: 'renamed', path: b, oldPath: a });
    else if (code.startsWith('A')) out.push({ status: 'added', path: a });
    else if (code.startsWith('D')) out.push({ status: 'deleted', path: a });
    else out.push({ status: 'modified', path: a });
  }
  return out.sort((x, y) => x.path.localeCompare(y.path));
}

export interface FileTreeFolder {
  // The folder's label: several path segments when it is a chain of
  // single-child folders ("src/components/lab").
  name: string;
  // Full path from the root, for a stable id.
  path: string;
  folders: FileTreeFolder[];
  files: ChangedFile[];
}

// fileTree — changed files as folders, the way the Source Control view shows
// them in tree mode: folders first, chains of single-child folders compacted.
export function fileTree(files: ChangedFile[]): FileTreeFolder {
  const root: FileTreeFolder = { name: '', path: '', folders: [], files: [] };
  for (const f of files) {
    const parts = f.path.split('/');
    let dir = root;
    for (const part of parts.slice(0, -1)) {
      let next = dir.folders.find((x) => x.name === part);
      if (!next) { next = { name: part, path: dir.path ? `${dir.path}/${part}` : part, folders: [], files: [] }; dir.folders.push(next); }
      dir = next;
    }
    dir.files.push(f);
  }
  const compact = (d: FileTreeFolder): FileTreeFolder => {
    let cur = d;
    while (cur.files.length === 0 && cur.folders.length === 1 && cur.path) {
      const only = cur.folders[0] as FileTreeFolder;
      cur = { ...only, name: `${cur.name}/${only.name}` };
    }
    return { ...cur, folders: cur.folders.map(compact).sort((a, b) => a.name.localeCompare(b.name)) };
  };
  return compact(root);
}

export interface ReviewComment {
  // GitHub's node id of the comment.
  id: string;
  author: string;
  body: string;
  createdAt: string;
  // Part of the viewer's pending (not yet submitted) review.
  pending: boolean;
}

export interface ReviewThread {
  // GitHub's node id of the thread.
  id: string;
  path: string;
  // 1-based line in the file on `side`.
  line: number;
  side: 'LEFT' | 'RIGHT';
  resolved: boolean;
  // The code under the comment has changed since; `line` is where it was.
  outdated: boolean;
  comments: ReviewComment[];
}

// parseReviewThreads — line comments of a PR from the GitHub GraphQL
// `reviewThreads` query. An outdated thread has no current line; it is placed
// on the line it was written for and flagged.
export function parseReviewThreads(json: string): { threads: ReviewThread[]; outdated: number } {
  interface Node {
    id?: string; isResolved?: boolean; path?: string; line?: number | null; originalLine?: number | null; diffSide?: string;
    comments?: { nodes?: { id?: string; author?: { login?: string } | null; body?: string; createdAt?: string; state?: string }[] };
  }
  let nodes: Node[] = [];
  try {
    nodes = (JSON.parse(json) as { data?: { repository?: { pullRequest?: { reviewThreads?: { nodes?: Node[] } } } } })
      .data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
  } catch { return { threads: [], outdated: 0 }; }
  const threads: ReviewThread[] = [];
  let outdated = 0;
  for (const n of nodes) {
    const comments = (n.comments?.nodes ?? []).map((c): ReviewComment => ({
      id: c.id ?? '', author: c.author?.login ?? 'ghost', body: c.body ?? '', createdAt: c.createdAt ?? '', pending: c.state === 'PENDING',
    }));
    if (!n.path || comments.length === 0) continue;
    const stale = typeof n.line !== 'number';
    const line = stale ? n.originalLine : n.line;
    if (typeof line !== 'number') continue;
    if (stale) outdated++;
    threads.push({ id: n.id ?? '', path: n.path, line, side: n.diffSide === 'LEFT' ? 'LEFT' : 'RIGHT', resolved: Boolean(n.isResolved), outdated: stale, comments });
  }
  return { threads, outdated };
}

export * from './protocol.ts';
import type { LocalComment, LocalThread } from './protocol.ts';

export interface ThreadSummary {
  // The first line of the thread's first comment.
  title: string;
  // Who started it and where it goes: the agent's finding, the user's
  // comment for GitHub, or the user's question to the agent.
  kind: 'finding' | 'github' | 'agent';
  unsent: boolean;
  published: boolean;
}

// summarize — one row of the draft list.
export function summarize(t: LocalThread): ThreadSummary {
  const first = t.comments[0];
  const line = (first?.body ?? '').split('\n').map((x) => x.trim()).find(Boolean) ?? '';
  return {
    title: line.length > 90 ? `${line.slice(0, 89)}…` : line,
    kind: first?.author === 'agent' ? 'finding' : first?.to === 'agent' ? 'agent' : 'github',
    unsent: t.comments.some((c) => c.unsent),
    published: t.state === 'published',
  };
}


// The user's part in a code window. A reviewer (the `code-review` skill, a
// `pr-<n>` scratch) writes comments for the PR author; an author (the `task`
// skill, a `task-<key>` scratch) only talks to the agent about their own code.
export type ReviewRole = 'reviewer' | 'author';

// roleOf — the role by the name of the skill's scratch folder.
export function roleOf(scratchName: string): ReviewRole | null {
  if (/^pr-\d+$/.test(scratchName)) return 'reviewer';
  if (scratchName.startsWith('task-')) return 'author';
  return null;
}

// One comment of a thread as the panel draws it: a comment that is on GitHub,
// or a local one with where it stands — `local` (not on GitHub), `draft` (in
// the user's pending review) or `submitted`.
export type ThreadComment =
  | { from: 'github'; comment: ReviewComment }
  | { from: 'local'; comment: LocalComment; published: 'local' | 'draft' | 'submitted' };

// mergeThread — one conversation out of a GitHub thread and its local record,
// either of which may be missing. A local comment the skill has published
// stands in for its GitHub copy, so it stays editable; the rest go in order of
// time, so the author's answers on GitHub and the local talk with the agent
// read as they happened.
export function mergeThread(gh: ReviewThread | undefined, local: LocalThread | undefined): ThreadComment[] {
  const copies = new Map<string, string>();
  for (const [id, c] of Object.entries(local?.github?.comments ?? {})) if (c?.id) copies.set(c.id, id);
  const onGithub = new Map((gh?.comments ?? []).map((c) => [c.id, c]));
  const out: { time: number; item: ThreadComment }[] = [];
  for (const c of gh?.comments ?? []) {
    if (!copies.has(c.id)) out.push({ time: Date.parse(c.createdAt) || 0, item: { from: 'github', comment: c } });
  }
  for (const c of local?.comments ?? []) {
    const known = local?.github?.comments?.[c.id];
    const copy = known?.id ? onGithub.get(known.id) : undefined;
    // A published comment whose copy is not in the last fetch is taken as still in the draft.
    const published = !known ? 'local' : copy && !copy.pending ? 'submitted' : 'draft';
    out.push({ time: (c.at ? Date.parse(c.at) : 0) || 0, item: { from: 'local', comment: c, published } });
  }
  return out.map((x, i) => ({ ...x, i })).sort((a, b) => a.time - b.time || a.i - b.i).map((x) => x.item);
}
