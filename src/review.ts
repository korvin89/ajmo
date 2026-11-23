// review.ts — the "Changes" view of a code window: what the worktree changes
// against its base, as diffs whose right side is the real file, plus the PR's
// existing line comments from GitHub shown in place. Active only when the
// window's folder is a git worktree (a task worktree or a review checkout).
import * as vscode from 'vscode';
import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as model from './reviewModel.ts';
import * as skills from './skills.ts';
import type { ChangedFile, FileTreeFolder, InboxEvent, LocalThread, ReviewThread } from './reviewModel.ts';

const SCHEME = 'ajmo-base';

const THREADS_QUERY = 'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){'
  + 'pullRequest(number:$number){reviewThreads(first:100){nodes{id isResolved path line originalLine diffSide '
  + 'comments(first:100){nodes{id author{login} body createdAt state}}}}}}}';

interface State {
  // The commit the diff is taken against: the merge base with the PR's base or the default branch.
  base: string;
  // What the base is, for the view description.
  baseLabel: string;
  files: ChangedFile[];
  note: string;
}

export function activateReview(context: vscode.ExtensionContext, env: () => NodeJS.ProcessEnv): void {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  // A linked worktree has a `.git` file; a main checkout has a `.git` folder.
  let isWorktree = false;
  try { isWorktree = Boolean(root) && fs.statSync(path.join(root as string, '.git')).isFile(); } catch { /* not a repository */ }
  void vscode.commands.executeCommand('setContext', 'ajmo.reviewFolder', isWorktree);
  if (!root || !isWorktree) return;

  const run = (cmd: string, args: string[]): Promise<string | null> => new Promise((resolve) => {
    cp.execFile(cmd, args, { cwd: root, env: env(), timeout: 30000, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout) => resolve(err ? null : stdout));
  });
  const git = (...args: string[]): Promise<string | null> => run('git', ['-c', 'core.quotepath=false', ...args]);
  // A file at a commit as bytes: images and other binaries must not go through a string.
  const gitBytes = (ref: string, file: string): Promise<Uint8Array> => new Promise((resolve) => {
    cp.execFile('git', ['show', `${ref}:${file}`], { cwd: root, env: env(), timeout: 30000, maxBuffer: 256 * 1024 * 1024, encoding: 'buffer' },
      (err, stdout) => resolve(err ? new Uint8Array() : stdout));
  });

  // The left side of a diff: the file as it is at the base commit.
  const baseUri = (ref: string, file: string): vscode.Uri =>
    vscode.Uri.from({ scheme: SCHEME, path: `/${file}`, query: JSON.stringify({ ref }) });
  const fileUri = (file: string): vscode.Uri => vscode.Uri.file(path.join(root, file));

  let state: State = { base: '', baseLabel: '', files: [], note: 'Loading…' };
  const changed = new vscode.EventEmitter<void>();

  // The list can be flat (file name, folder in gray) or a folder tree; the choice is remembered.
  let asTree = context.globalState.get('changesAsTree', false);
  const setTreeMode = (on: boolean): void => {
    asTree = on;
    void context.globalState.update('changesAsTree', on);
    void vscode.commands.executeCommand('setContext', 'ajmo.changesAsTree', on);
    changed.fire();
  };
  void vscode.commands.executeCommand('setContext', 'ajmo.changesAsTree', asTree);
  const isFolder = (el: ChangedFile | FileTreeFolder): el is FileTreeFolder => 'folders' in el;

  const provider: vscode.TreeDataProvider<ChangedFile | FileTreeFolder> = {
    onDidChangeTreeData: changed.event,
    getChildren: (el) => {
      if (!asTree) return el ? [] : state.files;
      const dir = el ? (isFolder(el) ? el : null) : model.fileTree(state.files);
      return dir ? [...dir.folders, ...dir.files] : [];
    },
    getTreeItem: (f) => {
      if (isFolder(f)) {
        const t = new vscode.TreeItem(f.name, vscode.TreeItemCollapsibleState.Expanded);
        t.id = `dir:${f.path}`;
        t.iconPath = vscode.ThemeIcon.Folder;
        t.resourceUri = fileUri(f.path);
        return t;
      }
      const t = new vscode.TreeItem(path.basename(f.path));
      t.id = f.path;
      const dir = asTree ? '.' : path.dirname(f.path);
      t.description = [dir === '.' ? '' : dir, f.status === 'modified' ? '' : f.status].filter(Boolean).join(' · ');
      t.resourceUri = fileUri(f.path);
      t.tooltip = f.oldPath ? `${f.oldPath} → ${f.path}` : f.path;
      t.command = { command: 'ajmo.changes.open', title: 'Open Changes', arguments: [f] };
      return t;
    },
  };
  const view = vscode.window.createTreeView('ajmo.changes', { treeDataProvider: provider });

  // The PR's line threads as last fetched from GitHub; drawn by showLocal together with the local ones.
  let ghThreads: ReviewThread[] = [];

  function openDiff(f: ChangedFile): void {
    // A missing side is an empty document: the provider returns '' for an unknown ref.
    const left = f.status === 'added' ? baseUri('', f.path) : baseUri(state.base, f.oldPath ?? f.path);
    const right = f.status === 'deleted' ? baseUri('', f.path) : fileUri(f.path);
    void vscode.commands.executeCommand('vscode.diff', left, right, `${path.basename(f.path)} (${state.baseLabel} ↔ here)`);
  }

  async function fetchThreads(prUrl: string): Promise<string> {
    const repo = skills.prRepo(prUrl);
    if (!repo) return '';
    const json = await run('gh', ['api', 'graphql', '-f', `query=${THREADS_QUERY}`,
      '-F', `owner=${repo.owner}`, '-F', `name=${repo.name}`, '-F', `number=${repo.number}`]);
    if (json === null) return 'Could not load the PR comments from GitHub (gh).';
    const { threads, outdated } = model.parseReviewThreads(json);
    ghThreads = threads;
    const parts = [`${threads.length} comment thread${threads.length === 1 ? '' : 's'} on GitHub`];
    if (outdated) parts.push(`${outdated} of them outdated`);
    return parts.join(', ');
  }

  // ---- Local threads: the user's comments and the agent's findings ----

  // The skill's scratch folder for this worktree: next to a review checkout,
  // or the task whose unit owns the worktree. Without one nobody would read
  // the comments, so writing them is off.
  let scratch: string | null = null;
  async function findScratch(): Promise<string | null> {
    if (skills.prHeadFolder(root as string) !== null) return path.dirname(root as string);
    const common = (await git('rev-parse', '--path-format=absolute', '--git-common-dir'))?.trim();
    if (!common) return null;
    for (const dir of skills.REVIEW_ROOTS.map((r) => path.join(common, r))) {
      let names: string[] = [];
      try { names = fs.readdirSync(dir); } catch { continue; }
      for (const name of names.filter((x) => x.startsWith('task-'))) {
        let json = '';
        try { json = fs.readFileSync(path.join(dir, name, 'task.json'), 'utf8'); } catch { continue; }
        if (skills.taskWorktrees(json).some((w) => path.resolve(w.dir) === path.resolve(root as string))) return path.join(dir, name);
      }
    }
    return null;
  }
  // The agent writes threads.json when it reviews or syncs: redraw the threads
  // as soon as the file changes, without a manual refresh.
  let watcher: fs.FSWatcher | undefined;
  let watched: string | null = null;
  let redraw: NodeJS.Timeout | undefined;
  function watchScratch(): void {
    if (watched === scratch) return;
    watcher?.close();
    watcher = undefined;
    watched = scratch;
    if (!scratch) return;
    try {
      watcher = fs.watch(scratch, (_event, name) => {
        // Our own writes to inbox.jsonl redraw at once; this is for the agent's file.
        if (name && !String(name).startsWith('threads.json')) return;
        clearTimeout(redraw);
        redraw = setTimeout(() => showLocal(), 200);
      });
    } catch { /* no watching: the refresh button still works */ }
  }

  const readOr = (file: string): string => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };

  const local = vscode.comments.createCommentController('ajmo.review', 'Review');
  local.options = { prompt: 'Comment for the PR author, or ask the agent', placeHolder: 'Write a comment' };
  local.commentingRangeProvider = {
    provideCommentingRanges: (doc) => {
      const inRoot = doc.uri.scheme === SCHEME || (doc.uri.scheme === 'file' && !path.relative(root as string, doc.uri.fsPath).startsWith('..'));
      return scratch && inRoot ? [new vscode.Range(0, 0, Math.max(0, doc.lineCount - 1), 0)] : [];
    },
  };
  // Drawn threads by id. They are updated in place: recreating a thread makes
  // the editor jump, which is what the user sees on every comment otherwise.
  const drawn = new Map<string, vscode.CommentThread>();
  // Ids of the threads the local files hold, and where the GitHub threads sit:
  // the first local reply in a GitHub thread has to say which thread it is.
  let localIds = new Set<string>();
  const ghMeta = new Map<string, { path: string; line: number; side: 'LEFT' | 'RIGHT'; thread: string }>();
  const threadIds = new WeakMap<vscode.CommentThread, string>();
  const newId = (prefix: string): string => `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;


  // Thread avatars are plain images, so each has a dark and a light file and
  // the threads are redrawn when the colour theme changes.
  type Voice = 'author' | 'ask' | 'agent';
  const avatar = (voice: Voice): vscode.Uri => {
    const kind = vscode.window.activeColorTheme.kind;
    const dark = kind === vscode.ColorThemeKind.Dark || kind === vscode.ColorThemeKind.HighContrast;
    return vscode.Uri.joinPath(context.extensionUri, 'media', `thread-${voice}-${dark ? 'dark' : 'light'}.svg`);
  };

  // The "Draft" view: every local thread in one list.
  let draft: LocalThread[] = [];
  const draftChanged = new vscode.EventEmitter<void>();
  // The same three icons as the thread avatars, here as theme icons.
  const DRAFT_ICONS = { finding: 'robot', github: 'comment', agent: 'chat-sparkle' } as const;
  const draftView = vscode.window.createTreeView('ajmo.draft', {
    treeDataProvider: {
      onDidChangeTreeData: draftChanged.event,
      getChildren: (el?: LocalThread) => (el ? [] : draft),
      getTreeItem: (t: LocalThread) => {
        const sum = model.summarize(t);
        const item = new vscode.TreeItem(sum.title || '(empty)');
        item.id = t.id;
        item.description = [`${path.basename(t.path)}:${t.line}`, t.outdated ? 'code changed' : '', sum.published ? 'in the GitHub draft' : '', sum.unsent ? 'not synced' : '']
          .filter(Boolean).join(' · ');
        item.iconPath = new vscode.ThemeIcon(sum.published ? 'github' : DRAFT_ICONS[sum.kind]);
        item.tooltip = `${t.path}:${t.line}\n\n${t.comments.map((c) => `${c.author === 'agent' ? 'Agent' : 'You'}: ${c.body}`).join('\n\n')}`;
        item.command = { command: 'ajmo.draft.open', title: 'Go to Comment', arguments: [t] };
        return item;
      },
    },
  });

  function openThread(t: LocalThread): void {
    const range = new vscode.Range(t.line - 1, 0, t.line - 1, 0);
    // VS Code cannot scroll to one thread among several on a line, so the others
    // on that line are folded and only the chosen one stays open.
    for (const other of draft) {
      const thread = drawn.get(other.id);
      if (!thread || other.path !== t.path || other.side !== t.side || other.line !== t.line) continue;
      thread.collapsibleState = other.id === t.id
        ? vscode.CommentThreadCollapsibleState.Expanded : vscode.CommentThreadCollapsibleState.Collapsed;
    }
    const file = state.files.find((f) => f.path === t.path);
    // A changed file opens as its diff, on the commented line; anything else as the plain file.
    if (file && t.side === 'RIGHT' && file.status !== 'deleted') {
      const left = file.status === 'added' ? baseUri('', file.path) : baseUri(state.base, file.oldPath ?? file.path);
      void vscode.commands.executeCommand('vscode.diff', left, fileUri(t.path), `${path.basename(t.path)} (${state.baseLabel} ↔ here)`, { selection: range });
    } else {
      void vscode.window.showTextDocument(t.side === 'LEFT' ? baseUri(state.base, t.path) : fileUri(t.path), { selection: range });
    }
  }

  function showLocal(): void {
    // A task keeps the threads of all its worktrees in one folder: take this window's.
    const threads = scratch
      ? model.threadsOf(model.localThreads(readOr(path.join(scratch, 'threads.json')), readOr(path.join(scratch, 'inbox.jsonl'))), root as string) : [];
    draft = [...threads].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
    draftView.message = draft.length > 0 ? undefined
      : scratch ? 'No comments yet. Click + next to a line in a diff or a file.'
        : 'Comments need a task or a review session for this worktree.';
    draftChanged.fire();
    void vscode.commands.executeCommand('setContext', 'ajmo.draftNotEmpty', draft.length > 0);
    void vscode.commands.executeCommand('setContext', 'ajmo.hasScratch', Boolean(scratch));

    const render = (c: model.ThreadComment): vscode.Comment => c.from === 'github' ? {
      body: new vscode.MarkdownString(c.comment.body),
      mode: vscode.CommentMode.Preview,
      // The author's GitHub avatar marks a comment that is on GitHub.
      author: { name: c.comment.author, iconPath: vscode.Uri.parse(`https://github.com/${encodeURIComponent(c.comment.author)}.png?size=48`) },
      label: c.comment.pending ? 'in your GitHub draft' : undefined,
      timestamp: c.comment.createdAt ? new Date(c.comment.createdAt) : undefined,
    } : {
      body: new vscode.MarkdownString(c.comment.body),
      mode: vscode.CommentMode.Preview,
      // Local comments carry the panel's own avatars, so they differ from GitHub ones at a glance.
      // A robot is the agent speaking. A speech bubble is the user: plain for GitHub, with a sparkle for the agent.
      author: c.comment.author === 'agent' ? { name: 'Agent', iconPath: avatar('agent') }
        : { name: 'You', iconPath: avatar(c.comment.to === 'agent' ? 'ask' : 'author') },
      label: c.comment.unsent ? 'not synced' : c.published === 'draft' ? 'in your GitHub draft' : c.published === 'submitted' ? 'on GitHub' : undefined,
      timestamp: c.comment.at ? new Date(c.comment.at) : undefined,
      // The user's own comments can be edited and deleted; the id rides in the context value.
      contextValue: c.comment.author === 'user' ? `mine:${c.comment.id}` : undefined,
    };

    // Every thread once: a local one together with its copy on GitHub, when
    // the skill has published it, then the GitHub threads with no local record.
    const ghById = new Map(ghThreads.map((g) => [g.id, g]));
    const paired = new Set<string>();
    const items: { key: string; local?: LocalThread; gh?: ReviewThread }[] = [];
    for (const t of threads) {
      const gh = t.github?.thread ? ghById.get(t.github.thread) : undefined;
      if (gh) paired.add(gh.id);
      items.push({ key: t.id, local: t, gh });
    }
    for (const gh of ghThreads) if (!paired.has(gh.id)) items.push({ key: `gh:${gh.id}`, gh });

    localIds = new Set(threads.map((t) => t.id));
    ghMeta.clear();
    const alive = new Set<string>();
    for (const { key, local: t, gh } of items) {
      if (alive.has(key)) continue;
      alive.add(key);
      if (gh) ghMeta.set(key, { path: gh.path, line: gh.line, side: gh.side, thread: gh.id });
      const at = t ?? gh as ReviewThread;
      const comments = model.mergeThread(gh, t).map(render);
      let thread = drawn.get(key);
      if (thread) {
        // In place: a thread drawn again would scroll the editor and fold what the user has open.
        thread.comments = comments;
      } else {
        const uri = at.side === 'LEFT' ? baseUri(state.base, at.path) : fileUri(at.path);
        thread = local.createCommentThread(uri, new vscode.Range(at.line - 1, 0, at.line - 1, 0), comments);
        // Old talk on GitHub stays folded until somebody writes in it here.
        thread.collapsibleState = !t && gh && (gh.resolved || gh.outdated)
          ? vscode.CommentThreadCollapsibleState.Collapsed : vscode.CommentThreadCollapsibleState.Expanded;
        drawn.set(key, thread);
        threadIds.set(thread, key);
      }
      // A reply in a thread that is only on GitHub needs a skill that will carry it there.
      thread.canReply = Boolean(scratch);
      const fromGithub = !t || key.startsWith('gh:');
      thread.label = [
        fromGithub ? 'GitHub' : t.state === 'published' ? 'In the GitHub draft' : '',
        gh?.resolved ? 'resolved' : '',
        t?.outdated ? 'the code under this comment has changed' : !t && gh?.outdated ? 'outdated: the code has changed since' : '',
      ].filter(Boolean).join(' · ') || undefined;
      thread.state = gh ? (gh.resolved ? vscode.CommentThreadState.Resolved : vscode.CommentThreadState.Unresolved) : undefined;
      // Offers Resolve or Unresolve in the thread's title.
      thread.contextValue = gh ? (gh.resolved ? 'gh:resolved' : 'gh:open') : undefined;
    }
    for (const [id, thread] of drawn) {
      if (!alive.has(id)) { thread.dispose(); drawn.delete(id); }
    }
    const unsent = model.unsentCount(threads);
    // Not a badge: a view badge adds up on the activity bar icon, where the number means "agents waiting for you".
    draftView.description = unsent > 0 ? `${unsent} not synced` : undefined;
  }

  function appendInbox(...events: InboxEvent[]): void {
    if (!scratch || events.length === 0) return;
    fs.appendFileSync(path.join(scratch, 'inbox.jsonl'), events.map((e) => `${JSON.stringify(e)}\n`).join(''));
    showLocal();
  }

  async function confirmed(message: string, detail: string, action: string): Promise<boolean> {
    return (await vscode.window.showWarningMessage(message, { modal: true, detail }, action)) === action;
  }

  // "Sync" from the IDE: the skill keeps a listener running in the session
  // (threads.sh wait) that ends when this file appears, which wakes the agent.
  // Without a live listener the agent would never notice, so say what to do.
  // The same file asks for a draft: its first word says which.
  function requestSync(what: 'sync' | 'draft' = 'sync'): void {
    if (!scratch) return;
    let listening = false;
    try { process.kill(Number(readOr(path.join(scratch, 'wait.pid')).trim()), 0); listening = true; } catch { /* no listener */ }
    if (!listening) {
      vscode.window.showWarningMessage(`Ajmo: the review session is not listening. Open its terminal and say "${what}" there.`);
      return;
    }
    fs.writeFileSync(path.join(scratch, 'sync.request'), `${what} ${new Date().toISOString()}\n`);
    vscode.window.setStatusBarMessage(what === 'draft'
      ? 'Ajmo: draft requested — the agent puts it into your pending review on GitHub; you submit it there'
      : 'Ajmo: sync requested — the agent answers in the threads', 5000);
  }

  // Resolving is the one thing the panel writes to GitHub itself: it is a
  // click on a thread that is already there, not a part of the draft.
  async function resolveThread(thread: vscode.CommentThread | undefined, resolved: boolean): Promise<void> {
    const key = thread ? threadIds.get(thread) : undefined;
    const meta = key ? ghMeta.get(key) : undefined;
    if (!thread || !meta) return;
    const field = resolved ? 'resolveReviewThread' : 'unresolveReviewThread';
    const out = await run('gh', ['api', 'graphql', '-f', `query=mutation($id:ID!){${field}(input:{threadId:$id}){thread{isResolved}}}`, '-f', `id=${meta.thread}`]);
    if (out === null) {
      vscode.window.showErrorMessage(`Ajmo: GitHub did not ${resolved ? 'resolve' : 'unresolve'} the thread (gh). You may have no right to do it on this PR.`);
      return;
    }
    const gh = ghThreads.find((g) => g.id === meta.thread);
    if (gh) gh.resolved = resolved;
    showLocal();
    thread.collapsibleState = resolved ? vscode.CommentThreadCollapsibleState.Collapsed : vscode.CommentThreadCollapsibleState.Expanded;
  }

  async function clearDraft(): Promise<void> {
    const n = draft.length;
    if (n === 0) return;
    const published = draft.filter((t) => t.state === 'published').length;
    const detail = ['Your comments and the agent\'s findings are removed from the local draft.',
      published ? `${published} of them ${published === 1 ? 'is' : 'are'} already in the GitHub draft and will be removed from it when the agent next runs draft.` : '',
      'This cannot be undone.'].filter(Boolean).join(' ');
    if (await confirmed(`Clear the draft: delete ${n} thread${n === 1 ? '' : 's'}?`, detail, 'Clear Draft')) {
      appendInbox(...draft.map((t): InboxEvent => ({ type: 'drop', thread: t.id })));
    }
  }

  const commentId = (c: vscode.Comment): string | undefined => /^mine:(.+)$/.exec(c.contextValue ?? '')?.[1];

  // The two buttons under a comment box: whom the comment is for.
  function addComment(reply: vscode.CommentReply, to: 'github' | 'agent'): void {
    const body = reply.text.trim();
    if (!body || !scratch) return;
    const thread = reply.thread;
    const known = threadIds.get(thread);
    const event: InboxEvent = { type: 'comment', id: newId('c'), thread: known ?? newId('t'), to, body, at: new Date().toISOString() };
    const gh = known ? ghMeta.get(known) : undefined;
    // In a task the anchor also names the worktree: its units share the scratch folder.
    const where = model.roleOf(path.basename(scratch)) === 'author' ? { root: root as string } : {};
    if (known && gh && !localIds.has(known)) {
      event.anchor = { path: gh.path, line: gh.line, side: gh.side, ...where };
      event.github = { thread: gh.thread };
    }
    if (!known) {
      const isBase = thread.uri.scheme === SCHEME;
      event.anchor = {
        path: isBase ? thread.uri.path.slice(1) : path.relative(root as string, thread.uri.fsPath).split(path.sep).join('/'),
        line: (thread.range?.start.line ?? 0) + 1,
        side: isBase ? 'LEFT' : 'RIGHT',
        ...where,
      };
      // The box VS Code opened becomes the thread itself: no redraw, no jump.
      drawn.set(event.thread, thread);
      threadIds.set(thread, event.thread);
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    }
    appendInbox(event);
  }

  async function refresh(): Promise<void> {
    scratch = await findScratch();
    watchScratch();
    // The role decides which buttons a comment box has.
    const role = scratch ? model.roleOf(path.basename(scratch)) : null;
    void vscode.commands.executeCommand('setContext', 'ajmo.reviewRole', role ?? '');
    local.options = role === 'author'
      ? { prompt: 'Ask the agent about this line', placeHolder: 'Write to the agent' }
      : { prompt: 'Comment for the PR author, or ask the agent', placeHolder: 'Write a comment' };
    // The PR: the number in a review checkout's path, otherwise the PR of the current branch.
    const n = skills.prHeadFolder(root as string);
    const prJson = await run('gh', ['pr', 'view', ...(n === null ? [] : [String(n)]), '--json', 'number,url,baseRefName,baseRefOid,headRefOid']);
    let pr: { number: number; url: string; baseRefName: string; baseRefOid: string; headRefOid?: string } | null = null;
    try { pr = prJson ? JSON.parse(prJson) : null; } catch { pr = null; }

    let base: string | null = null;
    let baseLabel = '';
    if (pr) {
      base = (await git('merge-base', 'HEAD', pr.baseRefOid))?.trim() || (await git('merge-base', 'HEAD', `origin/${pr.baseRefName}`))?.trim() || null;
      baseLabel = pr.baseRefName;
    }
    if (!base) {
      // No PR yet: compare with the repository's default branch.
      const def = (await git('rev-parse', '--abbrev-ref', 'origin/HEAD'))?.trim() || 'origin/main';
      base = (await git('merge-base', 'HEAD', def))?.trim() || null;
      baseLabel = def.replace(/^origin\//, '');
    }
    if (!base) {
      state = { base: '', baseLabel: '', files: [], note: 'Could not find the base commit to compare with.' };
    } else {
      // Against the working tree, so uncommitted changes of a task are included.
      const files = model.parseNameStatus((await git('diff', '--name-status', '-M', base)) ?? '');
      state = { base, baseLabel, files, note: '' };
      // Kept on a failed fetch: the threads drawn so far stay where they are.
      if (!pr) ghThreads = [];
      const threadsNote = pr ? await fetchThreads(pr.url) : '';
      state.note = files.length === 0 ? `No changes against ${baseLabel}.` : threadsNote;
      // A review checkout stays on the commit that was reviewed: say when the PR has moved on.
      if (pr?.headRefOid && skills.prHeadFolder(root as string) !== null) {
        const here = (await git('rev-parse', 'HEAD'))?.trim();
        if (here && here !== pr.headRefOid) state.note = `The PR has new commits: press Sync in the Draft view and the review moves to them. ${state.note}`.trim();
      }
    }
    view.description = pr ? `PR #${pr.number} → ${state.baseLabel}` : state.baseLabel ? `vs ${state.baseLabel}` : undefined;
    view.message = state.note || undefined;
    changed.fire();
    showLocal();
  }

  const readBase = (uri: vscode.Uri): Promise<Uint8Array> => {
    let ref = '';
    try { ref = (JSON.parse(uri.query) as { ref?: string }).ref ?? ''; } catch { /* an empty side */ }
    return ref ? gitBytes(ref, uri.path.slice(1)) : Promise.resolve(new Uint8Array());
  };
  const readOnly = (): never => { throw vscode.FileSystemError.NoPermissions('The base side of a diff is read-only.'); };
  const baseFiles: vscode.FileSystemProvider = {
    onDidChangeFile: new vscode.EventEmitter<vscode.FileChangeEvent[]>().event,
    watch: () => new vscode.Disposable(() => undefined),
    stat: async (uri) => ({ type: vscode.FileType.File, ctime: 0, mtime: 0, size: (await readBase(uri)).byteLength }),
    readFile: readBase,
    readDirectory: () => [],
    createDirectory: readOnly,
    writeFile: readOnly,
    delete: readOnly,
    rename: readOnly,
  };

  context.subscriptions.push(
    view, draftView, draftChanged, local, changed,
    { dispose: () => { watcher?.close(); clearTimeout(redraw); } },
    vscode.window.onDidChangeActiveColorTheme(() => showLocal()),
    vscode.commands.registerCommand('ajmo.draft.open', (t?: LocalThread) => { if (t) openThread(t); }),
    vscode.commands.registerCommand('ajmo.review.comment', (r: vscode.CommentReply) => addComment(r, 'github')),
    vscode.commands.registerCommand('ajmo.review.replyReviewer', (r: vscode.CommentReply) => addComment(r, 'github')),
    vscode.commands.registerCommand('ajmo.review.askAgent', (r: vscode.CommentReply) => addComment(r, 'agent')),
    vscode.commands.registerCommand('ajmo.review.deleteComment', async (c: vscode.Comment) => {
      const id = commentId(c);
      if (id && await confirmed('Delete this comment?', 'This cannot be undone.', 'Delete')) appendInbox({ type: 'delete', comment: id });
    }),
    vscode.commands.registerCommand('ajmo.draft.clear', () => void clearDraft()),
    vscode.commands.registerCommand('ajmo.draft.sync', () => requestSync('sync')),
    vscode.commands.registerCommand('ajmo.draft.publish', () => requestSync('draft')),
    vscode.commands.registerCommand('ajmo.review.resolve', (t?: vscode.CommentThread) => resolveThread(t, true)),
    vscode.commands.registerCommand('ajmo.review.unresolve', (t?: vscode.CommentThread) => resolveThread(t, false)),
    vscode.commands.registerCommand('ajmo.review.editComment', (c: vscode.Comment) => {
      const thread = [...drawn.values()].find((t) => t.comments.includes(c));
      if (!thread) return;
      // Switch this comment to its edit box; the Save / Cancel buttons appear under it.
      thread.comments = thread.comments.map((x) => (x === c
        ? { ...x, mode: vscode.CommentMode.Editing, body: typeof x.body === 'string' ? x.body : x.body.value } : x));
    }),
    vscode.commands.registerCommand('ajmo.review.saveComment', (c: vscode.Comment) => {
      const id = commentId(c);
      const body = (typeof c.body === 'string' ? c.body : c.body.value).trim();
      if (id && body) appendInbox({ type: 'edit', comment: id, body }); else showLocal();
    }),
    vscode.commands.registerCommand('ajmo.review.cancelEdit', () => showLocal()),
    // A read-only file system rather than a text content provider: the image
    // editor reads the base side as a file and fails on a text-only scheme.
    vscode.workspace.registerFileSystemProvider(SCHEME, baseFiles, { isReadonly: true }),
    vscode.commands.registerCommand('ajmo.changes.refresh', () => void refresh()),
    vscode.commands.registerCommand('ajmo.changes.open', (f?: ChangedFile) => { if (f) openDiff(f); }),
    vscode.commands.registerCommand('ajmo.changes.asTree', () => setTreeMode(true)),
    vscode.commands.registerCommand('ajmo.changes.asList', () => setTreeMode(false)),
  );
  void refresh();
}
