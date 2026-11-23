// protocol.ts — the thread files exchanged with the review skill, as described
// in docs/review-protocol.md. Pure; shared by the review part, which draws and
// writes them, and the agents part, which only counts unsynced comments.
//
// Two files in the skill's scratch folder, one writer each, so the panel and
// the agent never write to the same file:
//   threads.json — written by the skill: every thread as the agent knows it,
//                  and `cursor`, the number of inbox lines it has folded in;
//   inbox.jsonl  — appended by the panel: what the user wrote since.
// The panel shows threads.json with the inbox lines after `cursor` applied.

export interface LocalComment {
  id: string;
  author: 'user' | 'agent';
  // Where a user's comment goes: `github` — into the GitHub pending review
  // as written (a review comment for the PR author, or a reply to a
  // reviewer); `agent` — a question or a command for the agent, never
  // published.
  to?: 'github' | 'agent';
  body: string;
  at?: string;
  // Written, edited since the last sync: the agent has not seen this text yet.
  unsent?: boolean;
}

export interface LocalThread {
  id: string;
  path: string;
  line: number;
  side: 'LEFT' | 'RIGHT';
  // open — being discussed; published — in the GitHub draft; dropped — gone.
  state: 'open' | 'published' | 'dropped';
  comments: LocalComment[];
  // The worktree the thread's `path` is in, when the scratch folder serves
  // several: a task with more than one unit. Absent in a review.
  root?: string;
  // The PR got new commits and the code under the thread changed; `line` is
  // where it was carried to.
  outdated?: boolean;
  // Where the thread is in the GitHub draft once the skill has published it.
  // A thread whose id starts with "gh:" lives on GitHub (another reviewer's or
  // the author's, or the user's own submitted one); its local comments are
  // replies in it. `comments` maps a local comment id to its published copy.
  github?: { thread?: string; comments?: Record<string, { id?: string }> };
}

export type InboxEvent =
  | { type: 'comment'; id: string; thread: string; to: 'github' | 'agent'; body: string; at?: string;
      // Present when the comment starts a new thread.
      // `root` is the window's folder, written in a task: its units share one scratch folder.
      anchor?: { path: string; line: number; side: 'LEFT' | 'RIGHT'; root?: string };
      // Present with `anchor` when the comment is the first local one in a thread that exists on GitHub.
      github?: { thread: string } }
  | { type: 'edit'; comment: string; body: string }
  | { type: 'delete'; comment: string }
  // Removes a whole thread, the agent's findings in it included.
  | { type: 'drop'; thread: string };

export function parseInbox(text: string): InboxEvent[] {
  const out: InboxEvent[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as InboxEvent;
      if ((e.type === 'comment' && e.id && e.thread && typeof e.body === 'string')
        || (e.type === 'edit' && e.comment && typeof e.body === 'string') || (e.type === 'delete' && e.comment)
        || (e.type === 'drop' && e.thread)) out.push(e);
    } catch { /* a torn line: skip it */ }
  }
  return out;
}

// localThreads — what the panel shows: the agent's threads plus the user's
// inbox lines the agent has not folded in yet.
export function localThreads(threadsJson: string, inboxText: string): LocalThread[] {
  let file: { cursor?: number; threads?: LocalThread[] } = {};
  try { file = JSON.parse(threadsJson) as typeof file; } catch { /* no agent file yet */ }
  const threads = (Array.isArray(file.threads) ? file.threads : [])
    .filter((t) => t && t.id && t.path && typeof t.line === 'number' && t.state !== 'dropped')
    .map((t): LocalThread => ({ ...t, outdated: t.outdated === true ? true : undefined, side: t.side === 'LEFT' ? 'LEFT' : 'RIGHT', state: t.state === 'published' ? 'published' : 'open',
      comments: (Array.isArray(t.comments) ? t.comments : []).map((c) => ({ ...c })) }));
  const pending = parseInbox(inboxText).slice(Math.max(0, file.cursor ?? 0));
  for (const e of pending) {
    if (e.type === 'drop') {
      const at = threads.findIndex((x) => x.id === e.thread);
      if (at >= 0) threads.splice(at, 1);
      continue;
    }
    // Edits and deletes apply to the user's own comments only, synced or not.
    if (e.type === 'delete') {
      for (const t of threads) t.comments = t.comments.filter((c) => c.id !== e.comment || c.author !== 'user');
      continue;
    }
    if (e.type === 'edit') {
      for (const t of threads) for (const c of t.comments) if (c.id === e.comment && c.author === 'user') { c.body = e.body; c.unsent = true; }
      continue;
    }
    let t = threads.find((x) => x.id === e.thread);
    if (!t && e.anchor) {
      t = { id: e.thread, path: e.anchor.path, line: e.anchor.line, side: e.anchor.side, state: 'open', comments: [],
        root: e.anchor.root || undefined,
        github: e.github?.thread ? { thread: e.github.thread } : undefined };
      threads.push(t);
    }
    t?.comments.push({ id: e.id, author: 'user', to: e.to, body: e.body, at: e.at, unsent: true });
  }
  return threads.filter((t) => t.comments.length > 0);
}

// threadsOf — the threads that belong to a window's folder: those written
// for it, and those that name no folder at all.
export function threadsOf(threads: LocalThread[], root: string): LocalThread[] {
  const norm = (p: string): string => p.replace(/[\\/]+$/, '');
  return threads.filter((t) => !t.root || norm(t.root) === norm(root));
}

// unsentCount — how many of the user's comments wait for the next sync.
export function unsentCount(threads: LocalThread[]): number {
  return threads.reduce((n, t) => n + t.comments.filter((c) => c.unsent).length, 0);
}
