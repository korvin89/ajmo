// extension.ts — the agents part: Claude Code sessions and their statuses.
// Session state comes only from `claude agents --json --all`. The panel keeps
// one thing of its own: which completions you have seen and when we noticed a
// transition — in a globalStorage file shared by all windows.
import * as vscode from 'vscode';
import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as model from './model.ts';
import * as skills from './skills.ts';
import * as protocol from './protocol.ts';
import type { ActiveTab, Cls, Filter, SkillCommand, Procs, FilterState, Group, Item, Records, Session, TrackEvent, View, WindowInfo } from './model.ts';
import { FilterView } from './filterView.ts';
import { activateReview } from './review.ts';

// Status icons are monochrome, in the text colour: the shape carries the status.
const ICONS: Record<Exclude<Cls, 'done'>, string> = {
  waiting: 'debug-pause',
  failed: 'error',
  working: 'sync~spin',
  stopped: 'circle-slash',
  unknown: 'question',
};

function iconOf(item: Item): string {
  if (item.cls !== 'done') return ICONS[item.cls];
  return item.seen ? 'check' : 'pass-filled';
}

interface PrRef {
  label: string;
  // Repository folder to resolve the number in.
  dir: string;
  number?: number;
  url?: string;
}

type Node =
  | { type: 'group'; group: Group }
  | { type: 'session'; item: Item };

function cfg(): vscode.WorkspaceConfiguration { return vscode.workspace.getConfiguration('ajmo'); }

// VS Code started outside a terminal does not always see the shell PATH.
function execEnv(): NodeJS.ProcessEnv {
  const extra = [path.join(os.homedir(), '.local', 'bin'), path.join(os.homedir(), '.claude', 'local'),
    '/opt/homebrew/bin', '/usr/local/bin'];
  return { ...process.env, PATH: [process.env.PATH || '', ...extra].join(path.delimiter) };
}

class Store {
  private readonly file: string;
  constructor(dir: string) { this.file = path.join(dir, 'records.json'); fs.mkdirSync(dir, { recursive: true }); }
  read(): Records | null {
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')) as Records; } catch { return null; }
  }
  write(records: Records): void {
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(records));
    fs.renameSync(tmp, this.file);
  }
}

// Windows — which VS Code windows with the panel are open and what folders
// they hold. Each window has its own extension host, so the per-window file is
// named after its pid; a file of a dead process is garbage.
class Windows {
  private readonly dir: string;
  private readonly own: string;
  constructor(root: string) {
    this.dir = path.join(root, 'windows');
    this.own = path.join(this.dir, `${process.pid}.json`);
    fs.mkdirSync(this.dir, { recursive: true });
  }
  publish(): void {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const file = vscode.workspace.workspaceFile;
    const target = file ? (file.scheme === 'file' ? file.toString() : null)
      : folders.length === 1 && folders[0] ? folders[0].uri.toString() : null;
    const info: WindowInfo = { pid: process.pid, target, folders: folders.map((f) => f.uri.fsPath) };
    try { fs.writeFileSync(this.own, JSON.stringify(info)); } catch { /* without the file the window just won't be found */ }
  }
  remove(): void { try { fs.unlinkSync(this.own); } catch { /* already gone */ } }
  list(): WindowInfo[] {
    const out: WindowInfo[] = [];
    let names: string[] = [];
    try { names = fs.readdirSync(this.dir); } catch { return out; }
    for (const name of names) {
      const file = path.join(this.dir, name);
      try {
        const info = JSON.parse(fs.readFileSync(file, 'utf8')) as WindowInfo;
        process.kill(info.pid, 0);
        if (Array.isArray(info.folders)) out.push(info);
      } catch (e) {
        // ESRCH — no such process; a broken file is removed too. EPERM — alive but not ours.
        if ((e as NodeJS.ErrnoException).code !== 'EPERM') { try { fs.unlinkSync(file); } catch { /* race with another window */ } }
      }
    }
    return out;
  }
}

class AgentsProvider implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  view: View = { groups: [], filtered: 0, shown: 0, total: 0, counts: { waiting: 0, failed: 0, unseen: 0, working: 0 } };
  filter: FilterState = model.NO_FILTER;
  // Key of the session open in the window's active tab.
  activeKey: string | null = null;
  // Repositories the user collapsed; remembered across refreshes and window reloads.
  collapsed = new Set<string>();
  // Keys of sessions that have a PR to open.
  withPr = new Set<string>();

  // Everything a row is drawn from. The tree is refreshed only when this
  // changes: a refresh re-renders the rows, and VS Code then leaves the hover
  // buttons of the row under the pointer stuck on screen.
  private shown = '';

  set(view: View): void {
    this.view = view;
    const shown = JSON.stringify(view.groups.map((g) => [g.repo, g.attention,
      g.items.map((i) => [i.key, i.session.name, i.session.id, i.cls, i.seen, this.withPr.has(i.key)])]));
    if (shown === this.shown) return;
    this.shown = shown;
    this.emitter.fire();
  }

  getChildren(el?: Node): Node[] {
    if (!el) {
      const nodes: Node[] = this.view.groups.map((group) => ({ type: 'group', group }));
      return nodes;
    }
    if (el.type === 'group') return el.group.items.map((item) => ({ type: 'session', item }));
    return [];
  }

  // The tree needs it to select a row through reveal.
  getParent(el: Node): Node | undefined {
    if (el.type !== 'session') return undefined;
    const group = this.view.groups.find((g) => g.items.some((i) => i.key === el.item.key));
    return group ? { type: 'group', group } : undefined;
  }

  nodeOf(key: string): Node | undefined {
    for (const g of this.view.groups) {
      const item = g.items.find((i) => i.key === key);
      if (item) return { type: 'session', item };
    }
    return undefined;
  }


  getTreeItem(el: Node): vscode.TreeItem {
    if (el.type === 'group') {
      const t = new vscode.TreeItem(el.group.repo, this.collapsed.has(el.group.repo)
        ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded);
      t.id = `repo:${el.group.repo}`;
      t.description = el.group.attention > 0 ? `waiting: ${el.group.attention}` : '';
      t.iconPath = new vscode.ThemeIcon('repo');
      return t;
    }
    const { item } = el;
    const s = item.session;
    const title = s.name || s.id || item.key;
    const t = new vscode.TreeItem(title);
    t.id = `session:${item.key}`;
    // The row is the name and the status icon only; the tooltip is the plain name.
    t.tooltip = title;
    const icon = iconOf(item);
    t.iconPath = new vscode.ThemeIcon(icon);
    // Space-separated flags the context menu and inline buttons match on.
    t.contextValue = ['session',
      model.canAttach(s) ? 'attach' : '',
      item.cls === 'done' ? (item.seen ? 'seen' : 'unseen') : '',
      this.withPr.has(item.key) ? 'pr' : '',
    ].filter(Boolean).join(' ');
    t.command = { command: 'ajmo.open', title: 'Open session', arguments: [el] };
    return t;
  }

}

export function activate(context: vscode.ExtensionContext): void {
  const store = new Store(context.globalStorageUri.fsPath);
  const windows = new Windows(context.globalStorageUri.fsPath);
  windows.publish();
  const provider = new AgentsProvider();
  provider.collapsed = new Set(context.globalState.get<string[]>('collapsedRepos', []));
  const tree = vscode.window.createTreeView('ajmo.sessions', { treeDataProvider: provider });
  const bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  bar.show();

  let sessions: Session[] = [];
  let busy = false;
  let lastError = '';
  // Keys of sessions started by the Claude Code extension chat in this window.
  let ownChat = new Set<string>();
  // Which session runs in which terminal of this window — by processes, not by terminal name.
  let termKeys = new Map<vscode.Terminal, string>();
  // Short id of a session just started from the panel: its terminal opens once it shows up in a poll.
  let pendingOpen: { id: string; until: number } | null = null;
  // PR links per session key: from the number in the session name or from the
  // files of the user's task and review skills.
  let prs = new Map<string, PrRef[]>();
  // Terminals the panel has just opened: until they show up in the process
  // snapshot, the session is known from here. Entries are short-lived — after
  // that processes decide.
  const justOpened = new Map<vscode.Terminal, { key: string; at: number }>();
  function keyOf(term: vscode.Terminal | undefined): string | null {
    if (!term) return null;
    const fresh = justOpened.get(term);
    if (fresh && Date.now() - fresh.at > 10000) justOpened.delete(term);
    return termKeys.get(term) ?? justOpened.get(term)?.key ?? null;
  }
  // The name the panel already tried to give a terminal back: to avoid retrying forever.
  const renamed = new WeakMap<vscode.Terminal, string>();
  // The active session the list was last synced to. The row is revealed only
  // when this changes, so collapsing its repository afterwards sticks.
  let syncedKey: string | null = null;
  // The mode is remembered; the search query lives until the window reloads.
  let filter: FilterState = {
    mode: context.globalState.get<Filter>('filterMode', 'all'),
    query: '',
  };
  if (!(filter.mode in model.FILTER_LABELS)) filter.mode = 'all';

  function setFilter(patch: Partial<FilterState>): void {
    filter = { ...filter, ...patch };
    void context.globalState.update('filterMode', filter.mode);
    render();
  }
  const filterView = new FilterView(setFilter, () => setFilter(model.NO_FILTER));

  function render(): void {
    const records = store.read();
    const view = model.buildGroups(sessions, records, filter);
    const active = model.filterActive(filter);
    provider.filter = filter;
    provider.withPr = new Set(prs.keys());
    provider.set(view);
    filterView.update({ filter, modes: model.modeFacets(sessions, records), active, shown: view.shown, total: view.total });
    // Shows the Clear Filter button in the view title.
    void vscode.commands.executeCommand('setContext', 'ajmo.filterActive', active);
    const c = view.counts;
    const attention = c.waiting + c.failed + c.unseen;
    tree.badge = attention > 0 ? { value: attention, tooltip: `Waiting for you: ${attention}` } : undefined;
    tree.description = active ? `filtered: ${view.shown} of ${view.total}` : undefined;
    tree.message = lastError || (sessions.length === 0 ? 'No sessions.'
      : view.shown === 0 && active ? 'No sessions match the filter.' : undefined);
    const parts: string[] = [];
    if (c.waiting) parts.push(`$(debug-pause) ${c.waiting}`);
    if (c.failed) parts.push(`$(error) ${c.failed}`);
    if (c.unseen) parts.push(`$(pass-filled) ${c.unseen}`);
    if (c.working) parts.push(`$(sync) ${c.working}`);
    bar.text = `$(ajmo-logo) ${parts.length ? parts.join('  ') : 'agents'}`;
    bar.tooltip = `Claude agents — waiting: ${c.waiting}, failed: ${c.failed}, `
      + `done and unseen: ${c.unseen}, working: ${c.working}`;
    // With someone waiting, a click jumps to them; otherwise it opens the panel.
    bar.command = attention > 0 ? 'ajmo.nextWaiting' : 'ajmo.sessions.focus';
    bar.backgroundColor = c.waiting || c.failed
      ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
  }

  function notify(events: TrackEvent[]): void {
    // Only in the focused window: otherwise one event pops up in every window.
    if (!vscode.window.state.focused || !cfg().get('notifications', true)) return;
    const watching = activeKeyNow();
    for (const e of events) {
      if (e.cls === 'done' && !cfg().get('notifyOnDone', false)) continue;
      // The user is looking at this session's tab right now.
      if (model.sessionKey(e.session) === watching) continue;
      const name = e.session.name || model.sessionKey(e.session);
      const text = e.cls === 'waiting' ? `${name}: waiting for you (${model.statusLabel({ session: e.session, cls: 'waiting' })})`
        : e.cls === 'failed' ? `${name}: failed` : `${name}: done`;
      const shown = e.cls === 'failed'
        ? vscode.window.showWarningMessage(text, 'Open')
        : vscode.window.showInformationMessage(text, 'Open');
      shown.then((pick) => { if (pick) openSession(e.session); });
    }
  }

  function poll(): void {
    if (busy) return;
    busy = true;
    const bin = cfg().get('claudePath', 'claude');
    cp.execFile(bin, ['agents', '--json', '--all'], { env: execEnv(), timeout: 20000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        busy = false;
        if (err) {
          lastError = `Could not run "${bin} agents --json --all": ${String(stderr || err.message).trim().split('\n').pop()}`;
          render();
          return;
        }
        let list: unknown;
        try { list = JSON.parse(stdout); } catch { list = null; }
        if (!Array.isArray(list)) { lastError = 'Could not parse claude agents --json output as a JSON array.'; render(); return; }
        lastError = '';
        // Nothing to show without state and status. An interactive session comes
        // with a status but without id and state.
        sessions = (list as (Session | null)[])
          .filter((s): s is Session => Boolean(s && (s.sessionId || s.id) && (s.state || s.status)));
        const before = store.read();
        const { records, events } = model.track(before, sessions, Date.now());
        if (JSON.stringify(records) !== JSON.stringify(before)) store.write(records);
        prs = findPrs();
        seeActive();
        render();
        notify(events);
        void refreshProcesses();
        if (pendingOpen) {
          const started = sessions.find((x) => x.id === pendingOpen?.id);
          if (started) { pendingOpen = null; openSession(started); } else if (Date.now() > pendingOpen.until) pendingOpen = null;
        }
      });
  }


  function readProcs(): Promise<Procs> {
    return new Promise((resolve) => {
      cp.execFile('ps', ['-axo', 'pid=,ppid=,args='], { timeout: 5000, maxBuffer: 32 * 1024 * 1024 },
        (err, stdout) => resolve(model.parsePs(err ? '' : stdout)));
    });
  }

  // After every poll: which chats and terminals of this window hold which sessions.
  async function refreshProcesses(): Promise<void> {
    const procs = await readProcs();
    const self: WindowInfo[] = [{ pid: process.pid, target: null, folders: [] }];
    ownChat = new Set(sessions.filter((s) => s.kind === 'interactive' && s.pid && model.ownerWindow(self, s.pid, procs.parents))
      .map(model.sessionKey));
    const next = new Map<vscode.Terminal, string>();
    for (const t of vscode.window.terminals) {
      if (t.exitStatus !== undefined) continue;
      const key = model.terminalSessionKey(sessions, await t.processId, procs);
      if (key) next.set(t, key);
    }
    termKeys = next;
    await restoreAllTerminalNames();
    updateActive();
  }

  function activeTab(): ActiveTab | null {
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    const term = vscode.window.activeTerminal;
    if (tab?.input instanceof vscode.TabInputTerminal) {
      return { kind: 'terminal', label: tab.label, sessionKey: keyOf(term) };
    }
    if (tab?.input instanceof vscode.TabInputWebview && tab.input.viewType.includes('claudeVSCodePanel')) {
      return { kind: 'chat', label: tab.label };
    }
    // Session terminals in the bottom panel are not tabs: take the active terminal.
    if (term && cfg().get<string>('openIn', 'editor') === 'panel') {
      return { kind: 'terminal', label: term.name, sessionKey: keyOf(term) };
    }
    return null;
  }

  // On window reload VS Code does not restore the name the panel gave a
  // terminal. Only the active terminal can be renamed, so the name comes back
  // when you switch to it.
  function restoreTerminalName(): void {
    const term = vscode.window.activeTerminal;
    const key = term && termKeys.get(term);
    if (!term || !key) return;
    const name = model.terminalRename(sessions.find((s) => model.sessionKey(s) === key), term.name);
    if (!name || renamed.get(term) === name) return;
    renamed.set(term, name);
    void vscode.commands.executeCommand('workbench.action.terminal.renameWithArg', { name });
  }

  const GROUP_FOCUS = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth'];
  let namesRestored = false;
  let restoringNames = false;

  // Once after the window opens, gives every session terminal tab its name
  // back. VS Code can rename only the active terminal, so the tabs are
  // activated one by one and then each editor group gets back the tab that
  // was open.
  async function restoreAllTerminalNames(): Promise<void> {
    if (namesRestored || restoringNames || termKeys.size === 0) return;
    restoringNames = true;
    try {
      const groups = vscode.window.tabGroups;
      const tabNames = new Set(groups.all.flatMap((g) => g.tabs)
        .filter((t) => t.input instanceof vscode.TabInputTerminal).map((t) => t.label));
      const todo: { term: vscode.Terminal; name: string }[] = [];
      for (const [term, key] of termKeys) {
        const name = model.terminalRename(sessions.find((s) => model.sessionKey(s) === key), term.name);
        // Editor-tab terminals only: showing a bottom-panel terminal would open the panel itself.
        if (name && tabNames.has(term.name) && term !== vscode.window.activeTerminal) todo.push({ term, name });
      }
      restoreTerminalName();
      if (todo.length === 0) return;
      const before = groups.all.map((g) => ({ column: g.viewColumn, index: g.activeTab ? g.tabs.indexOf(g.activeTab) : -1 }));
      const activeColumn = groups.activeTabGroup.viewColumn;
      for (const { term, name } of todo) {
        term.show(true);
        for (let i = 0; i < 20 && vscode.window.activeTerminal !== term; i++) await new Promise((r) => setTimeout(r, 25));
        if (vscode.window.activeTerminal !== term) continue;
        renamed.set(term, name);
        await vscode.commands.executeCommand('workbench.action.terminal.renameWithArg', { name });
      }
      const focusGroup = async (column: number): Promise<boolean> => {
        const word = GROUP_FOCUS[column - 1];
        if (!word) return false;
        await vscode.commands.executeCommand(`workbench.action.focus${word}EditorGroup`);
        return true;
      };
      for (const b of before) {
        const g = groups.all.find((x) => x.viewColumn === b.column);
        if (!g || b.index < 0 || (g.activeTab && g.tabs.indexOf(g.activeTab) === b.index)) continue;
        if (await focusGroup(b.column)) await vscode.commands.executeCommand('workbench.action.openEditorAtIndex', b.index);
      }
      if (groups.activeTabGroup.viewColumn !== activeColumn) await focusGroup(activeColumn);
    } catch { /* failed — names come back when a tab is visited */ } finally {
      namesRestored = true;
      restoringNames = false;
    }
  }

  function setCollapsed(el: Node, collapsed: boolean): void {
    if (el.type !== 'group' || provider.collapsed.has(el.group.repo) === collapsed) return;
    if (collapsed) provider.collapsed.add(el.group.repo); else provider.collapsed.delete(el.group.repo);
    void context.globalState.update('collapsedRepos', [...provider.collapsed]);
  }

  function activeKeyNow(): string | null {
    return model.activeSessionKey(sessions, activeTab(), ownChat);
  }

  // A session whose tab is active in a focused window is being looked at: it
  // never stays "unseen". Returns whether a mark was cleared.
  function seeActive(): boolean {
    if (!vscode.window.state.focused) return false;
    const key = activeKeyNow();
    const records = key ? store.read() : null;
    if (!key || !records || !model.markSeen(records, key)) return false;
    store.write(records);
    return true;
  }

  // Selects the active tab's session in the list — the way the Explorer selects the open file.
  function updateActive(): void {
    // While the startup pass over tabs is running, leave the list selection alone.
    if (restoringNames) return;
    restoreTerminalName();
    const key = activeKeyNow();
    provider.activeKey = key;
    if (seeActive()) render();
    // Only while the panel is visible: reveal would otherwise open it.
    if (!tree.visible) return;
    if (key === syncedKey) return;
    syncedKey = key;
    const node = key ? provider.nodeOf(key) : undefined;
    if (!node) return;
    // Switching to a session's tab expands its repository if it was collapsed;
    // the expand event then drops it from the remembered collapsed set.
    tree.reveal(node, { select: true, focus: false, expand: true }).then(undefined, () => { syncedKey = null; });
  }

  function switchTo(w: WindowInfo): void {
    // The folder is already open in that window, so VS Code switches to it instead of creating a new one.
    if (w.target) vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.parse(w.target), { forceNewWindow: true });
  }

  // claude attach cannot open an interactive session. If it runs in the Claude
  // Code extension chat, show its tab (or the window that has it); otherwise
  // only say why nothing opened.
  async function revealInteractive(s: Session): Promise<void> {
    const label = s.name || model.sessionKey(s);
    if (s.kind !== 'interactive') { vscode.window.showInformationMessage(`Unexpected session id: ${s.id}`); return; }
    const all = windows.list();
    const owner = model.ownerWindow(all, s.pid, (await readProcs()).parents);
    if (owner?.pid === process.pid && s.sessionId) {
      try {
        // The command behind vscode://anthropic.claude-code/open?session=<id>:
        // it reveals an already open session tab instead of creating a new one.
        await vscode.commands.executeCommand('claude-vscode.primaryEditor.open', s.sessionId);
        return;
      } catch { /* no Claude Code extension or the command changed — the message below */ }
    } else if (owner?.target) {
      switchTo(owner);
      return;
    } else {
      const other = model.findWindow(all, s.cwd, process.pid);
      if (other) { switchTo(other); return; }
    }
    vscode.window.showInformationMessage(`"${label}" is an interactive session: it has no id for claude attach. `
      + 'It is open where it was started: in a terminal or in the Claude Code extension chat.');
  }

  function openSession(s: Session): void {
    const records = store.read();
    if (records && model.markSeen(records, model.sessionKey(s))) { store.write(records); render(); }
    if (!model.canAttach(s)) { void revealInteractive(s); return; }
    const name = model.terminalLabel(s);
    const key = model.sessionKey(s);
    const open = vscode.window.terminals.filter((t) => t.exitStatus === undefined);
    const existing = open.find((t) => keyOf(t) === key);
    if (existing) { existing.show(); return; }
    const inEditor = cfg().get('openIn', 'editor') === 'editor';
    const term = vscode.window.createTerminal({
      name,
      // No cwd on purpose: session ids resolve from any folder, and a cwd outside
      // the workspace makes VS Code append the folder name to the tab title.
      iconPath: new vscode.ThemeIcon('ajmo-logo'),
      location: inEditor ? vscode.TerminalLocation.Editor : vscode.TerminalLocation.Panel,
      env: { PATH: execEnv().PATH },
    });
    justOpened.set(term, { key, at: Date.now() });
    term.show();
    const bin = cfg().get('claudePath', 'claude');
    term.sendText(`${/^[\w./~-]+$/.test(bin) ? bin : JSON.stringify(bin)} attach ${s.id}`);
  }

  // Search across all sessions, including filtered-out and old ones: name, repository, status, id.
  async function findSession(): Promise<void> {
    const now = Date.now();
    const view = model.buildGroups(sessions, store.read());
    const picks = model.flatten(view).map((item) => ({
      label: `$(${iconOf(item)}) ${item.session.name || item.key}`,
      description: [item.repo, model.describe(item, now), item.session.id].filter(Boolean).join(' · '),
      item,
    }));
    const pick = await vscode.window.showQuickPick(picks, {
      placeHolder: 'Session name, repository, status or id', matchOnDescription: true,
    });
    if (pick) openSession(pick.item.session);
  }

  // The same choice as in the block above the list — for those who hid that block.
  async function chooseFilter(): Promise<void> {
    const modes = model.modeFacets(sessions, store.read());
    type Pick = vscode.QuickPickItem & { patch?: Partial<FilterState> };
    const mark = (on: boolean, label: string): string => `${on ? '$(check) ' : ''}${label}`;
    const picks: Pick[] = [
      ...(model.filterActive(filter) ? [{ label: '$(close) Clear filter', patch: model.NO_FILTER }] : []),
      ...modes.map((m) => ({ label: mark(m.id === filter.mode, m.label), description: String(m.count), detail: m.hint, patch: { mode: m.id } })),
    ];
    const pick = await vscode.window.showQuickPick(picks, { placeHolder: 'Which sessions to show in the list' });
    if (pick?.patch) setFilter(pick.patch);
  }

  // Skills the user can invoke with a slash: personal ones, the repository's
  // own, and those of enabled plugins. Read from their files, because the CLI
  // has no command that lists them.
  function readSkills(dir: string, plugin?: string, depth = 2): SkillCommand[] {
    const out: SkillCommand[] = [];
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        let text: string | null = null;
        try { text = fs.readFileSync(path.join(full, 'SKILL.md'), 'utf8'); } catch { /* a folder of skills, not a skill */ }
        if (text !== null) { const sk = model.parseSkill(text, e.name, plugin); if (sk) out.push(sk); }
        else if (depth > 0 && e.name !== 'node_modules') out.push(...readSkills(full, plugin, depth - 1));
      } else if (e.name.endsWith('.md') && e.name !== 'SKILL.md' && path.basename(dir) === 'commands') {
        try { const sk = model.parseSkill(fs.readFileSync(full, 'utf8'), e.name.slice(0, -3), plugin); if (sk) out.push(sk); } catch { /* unreadable */ }
      }
    }
    return out;
  }

  function pluginDirs(): Promise<{ name: string; dir: string }[]> {
    return new Promise((resolve) => {
      cp.execFile(cfg().get('claudePath', 'claude'), ['plugin', 'list', '--json'], { env: execEnv(), timeout: 15000, maxBuffer: 8 * 1024 * 1024 },
        (err, stdout) => {
          try {
            const list = JSON.parse(err ? '[]' : stdout) as { id?: string; enabled?: boolean; installPath?: string }[];
            resolve(list.filter((p) => p.enabled && p.id && p.installPath)
              .map((p) => ({ name: (p.id as string).split('@')[0] as string, dir: p.installPath as string })));
          } catch { resolve([]); }
        });
    });
  }

  async function loadSkills(repoDir: string): Promise<SkillCommand[]> {
    const claudeHome = path.join(os.homedir(), '.claude');
    const found = [
      ...readSkills(path.join(repoDir, '.claude', 'skills')), ...readSkills(path.join(repoDir, '.claude', 'commands'), undefined, 0),
      ...readSkills(path.join(claudeHome, 'skills')), ...readSkills(path.join(claudeHome, 'commands'), undefined, 0),
    ];
    for (const p of await pluginDirs()) {
      found.push(...readSkills(path.join(p.dir, 'skills'), p.name), ...readSkills(path.join(p.dir, 'commands'), p.name, 0));
    }
    return model.sortSkills(found);
  }

  // The prompt box with skill suggestions: while the text is an unfinished
  // /command the list offers skills, and picking one completes it; after that
  // the single row starts the session with the text as typed.
  function askPrompt(repo: string, skills: SkillCommand[]): Promise<string | undefined> {
    type Row = vscode.QuickPickItem & { skill?: string };
    return new Promise((resolve) => {
      const qp = vscode.window.createQuickPick<Row>();
      qp.title = `New session in ${repo}`;
      qp.placeholder = 'Type / for skills, or describe the task';
      qp.ignoreFocusOut = true;
      const skillRows: Row[] = skills.map((sk) => ({ label: sk.command, description: model.brief(sk.description), skill: sk.command }));
      const update = (): void => {
        const value = qp.value;
        qp.items = model.isPickingSkill(value) ? skillRows
          : value.trim() ? [{ label: '$(play) Start session', description: value.trim(), alwaysShow: true }] : [];
      };
      let result: string | undefined;
      qp.onDidChangeValue(update);
      qp.onDidAccept(() => {
        const row = qp.selectedItems[0] ?? qp.activeItems[0];
        if (row?.skill && model.isPickingSkill(qp.value)) { qp.value = `${row.skill} `; update(); return; }
        if (!qp.value.trim()) return;
        result = qp.value.trim();
        qp.hide();
      });
      qp.onDidHide(() => { qp.dispose(); resolve(result); });
      update();
      qp.show();
    });
  }

  function runClaude(args: string[], timeout = 30000): Promise<{ ok: boolean; out: string }> {
    return new Promise((resolve) => {
      cp.execFile(cfg().get('claudePath', 'claude'), args, { env: execEnv(), timeout, maxBuffer: 32 * 1024 * 1024 },
        (err, stdout, stderr) => resolve(err ? { ok: false, out: String(stderr || err.message).trim() } : { ok: true, out: stdout }));
    });
  }

  function openNextWaiting(): void {
    const next = model.nextAttention(sessions, store.read(), activeKeyNow());
    if (next) openSession(next); else vscode.window.setStatusBarMessage('Ajmo: nobody is waiting for you', 3000);
  }

  // What a session leaves on disk besides itself: a review's checkout and
  // thread files, or a task's worktrees. Found the same way as for Open Code.
  interface Leftover {
    what: string;
    notes: string[];
    remove: () => Promise<string | null>;
  }

  function sh(cmd: string, args: string[], cwd: string): Promise<{ code: number; out: string }> {
    return new Promise((resolve) => {
      cp.execFile(cmd, args, { cwd, env: execEnv(), timeout: 120000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
        resolve({ code, out: `${stdout}${code && stderr ? `\n${stderr}` : ''}` });
      });
    });
  }

  // Files of the `korvin89` skills are removed by that plugin's own
  // cleanup.sh: it knows the layout and checks for unsaved work first.
  async function korvinCleanup(root: string, key: string, what: string): Promise<Leftover | null> {
    const plugin = (await pluginDirs()).find((p) => p.name === 'korvin89');
    const script = plugin && path.join(plugin.dir, 'skills', 'cleanup', 'scripts', 'cleanup.sh');
    if (!script || !fs.existsSync(script)) return null;
    return {
      what,
      notes: ['removed by the korvin89 cleanup script, which checks for unsaved work first'],
      remove: async () => {
        let r = await sh('bash', [script, key], root);
        const ask = r.code === 10 ? skills.cleanupRequest(r.out) : null;
        if (ask) {
          if (!await confirmed(`Cleanup of ${key} has warnings. Remove anyway?`, ask.warnings.map((w) => `• ${w}`).join('\n'), 'Remove Anyway')) {
            return 'cleanup was cancelled';
          }
          r = await sh('bash', [script, key, `--yes=${ask.code}`], root);
        }
        return r.code === 0 ? null : (r.out.trim().split('\n').pop() || `cleanup.sh exited with ${r.code}`);
      },
    };
  }

  async function leftoverOf(s: Session): Promise<Leftover | null> {
    if (!s.cwd) return null;
    const root = skills.repoRoot(s.cwd);
    const review = reviewOf(s, root);
    if (review && fs.existsSync(review.scratch)) {
      if (path.basename(path.dirname(review.scratch)) !== 'ajmo') return korvinCleanup(root, `pr-${review.n}`, `the review files of PR #${review.n}`);
      // The ajmo plugin's own folder: the panel knows its layout.
      const head = checkoutOf(review.scratch);
      const notes: string[] = [];
      const unsent = protocol.unsentCount(protocol.localThreads(
        readText(path.join(review.scratch, 'threads.json')) ?? '', readText(path.join(review.scratch, 'inbox.jsonl')) ?? ''));
      if (unsent) notes.push(`${unsent} comment${unsent === 1 ? '' : 's'} the agent has not seen`);
      if (fs.existsSync(head) && (await sh('git', ['status', '--porcelain'], head)).out.trim()) notes.push('the checkout has local changes');
      return {
        what: `the review files of PR #${review.n} (${review.scratch})`,
        notes,
        remove: async () => {
          if (fs.existsSync(head)) {
            const r = await sh('git', ['worktree', 'remove', '--force', head], root);
            if (r.code !== 0) return r.out.trim().split('\n').pop() || 'git worktree remove failed';
          }
          try { fs.rmSync(review.scratch, { recursive: true, force: true }); } catch (e) { return String(e); }
          await sh('git', ['worktree', 'prune'], root);
          return null;
        },
      };
    }
    const task = taskOf(s, root);
    if (!task) return null;
    if (path.basename(path.dirname(task)) !== 'ajmo') return korvinCleanup(root, path.basename(task), `the task ${path.basename(task)}: its worktrees, pushed branches and working files`);
    // A task of the ajmo plugin: its worktrees, the local branches it created, its folder.
    // What is on GitHub — pushed branches and PRs — stays.
    const { worktrees, branches } = skills.taskCleanup(readText(path.join(task, 'task.json')) ?? '');
    const live = worktrees.filter((w) => fs.existsSync(w));
    const notes: string[] = [];
    for (const w of live) {
      if ((await sh('git', ['status', '--porcelain'], w)).out.trim()) notes.push(`${path.basename(w)} has uncommitted changes`);
      const ahead = await sh('git', ['log', '--oneline', 'HEAD', '--not', '--remotes'], w);
      if (ahead.code === 0 && ahead.out.trim()) notes.push(`${path.basename(w)} has commits that are not pushed`);
    }
    const prs = skills.taskPrUrls(readText(path.join(task, 'task.json')) ?? '').length;
    if (prs) notes.push(`${prs === 1 ? 'its PR and pushed branch stay' : 'its PRs and pushed branches stay'} on GitHub`);
    return {
      what: `the task ${path.basename(task)}: ${live.length === 1 ? 'its worktree' : `its ${live.length} worktrees`}, local branches and working files`,
      notes,
      remove: async () => {
        for (const w of live) {
          const r = await sh('git', ['worktree', 'remove', '--force', w], root);
          if (r.code !== 0) return r.out.trim().split('\n').pop() || 'git worktree remove failed';
        }
        await sh('git', ['worktree', 'prune'], root);
        for (const b of branches) await sh('git', ['branch', '-D', b], root);
        try { fs.rmSync(task, { recursive: true, force: true }); } catch (e) { return String(e); }
        return null;
      },
    };
  }

  function confirmed(message: string, detail: string, action: string): Promise<boolean> {
    return Promise.resolve(vscode.window.showWarningMessage(message, { modal: true, detail }, action)).then((a) => a === action);
  }

  async function deleteSession(s: Session): Promise<void> {
    const name = s.name || s.id;
    const left = await leftoverOf(s);
    const detail = ['Runs claude rm: the session is removed and so is its own worktree when that is safe.',
      left ? `This session also left ${left.what}.${left.notes.length ? ` Note: ${left.notes.join('; ')}.` : ''}` : '',
      'This cannot be undone.'].filter(Boolean).join('\n\n');
    const withFiles = 'Delete Session and Files';
    const only = left ? 'Delete Session Only' : 'Delete';
    const answer = await vscode.window.showWarningMessage(`Delete session "${name}"?`, { modal: true, detail },
      ...(left ? [withFiles, only] : [only]));
    if (answer !== withFiles && answer !== only) return;
    if (left && answer === withFiles) {
      const problem = await left.remove();
      if (problem) {
        vscode.window.showErrorMessage(`Ajmo: the files of "${name}" were not removed (${problem}); the session was kept.`);
        return;
      }
    }
    const r = await runClaude(['rm', s.id as string]);
    if (!r.ok) vscode.window.showErrorMessage(`Ajmo: could not delete "${name}": ${r.out.split('\n').pop()}`);
    poll();
  }

  function setSeen(s: Session, seen: boolean): void {
    const records = store.read();
    const key = model.sessionKey(s);
    if (records && (seen ? model.markSeen(records, key) : model.markUnseen(records, key))) { store.write(records); render(); }
  }

  // PR links. A review session names its PR; a task session is matched to the
  // task of the user's `task` skill through the task lock, which holds the
  // session id. Both skills keep their files in <repo>/.git/code-review/.
  const readText = (file: string): string | null => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };

  // Task folders of a repository's skill scratch, by the session id in their lock.
  function tasksIn(scratch: string): Map<string, string> {
    const found = new Map<string, string>();
    let names: string[] = [];
    try { names = fs.readdirSync(scratch); } catch { /* the repository has no skill scratch */ }
    for (const name of names) {
      if (!name.startsWith('task-')) continue;
      const id = skills.lockSessionId(readText(path.join(scratch, name, 'lock')) ?? '');
      if (id) found.set(id, path.join(scratch, name));
    }
    return found;
  }

  // The task a session drives: the folder whose lock holds its id, the
  // `ajmo` plugin's before `korvin89`'s.
  function taskOf(s: Session, root: string, list: (scratch: string) => Map<string, string> = tasksIn): string | undefined {
    if (!s.sessionId) return undefined;
    for (const r of skills.REVIEW_ROOTS) {
      const task = list(path.join(root, '.git', r)).get(s.sessionId);
      if (task) return task;
    }
    return undefined;
  }

  // The review a session runs: the scratch folder of its PR. A session of
  // the `ajmo` plugin is matched exactly, by the session id the skill writes
  // there; any other by the PR number in its name.
  function reviewOf(s: Session, root: string): { scratch: string; n: number } | null {
    if (s.sessionId) {
      const dir = path.join(root, '.git', 'ajmo');
      let names: string[] = [];
      try { names = fs.readdirSync(dir); } catch { /* no ajmo reviews in this repository */ }
      for (const name of names) {
        const n = skills.prFolderNumber(name);
        if (n !== null && readText(path.join(dir, name, 'session'))?.trim() === s.sessionId) return { scratch: path.join(dir, name), n };
      }
    }
    const n = skills.prNumber(s.name);
    if (n === null) return null;
    const found = skills.REVIEW_ROOTS.map((r) => path.join(root, '.git', r, `pr-${n}`)).find((d) => fs.existsSync(d));
    return { scratch: found ?? path.join(root, '.git', 'code-review', `pr-${n}`), n };
  }

  // The checkout of a review: the folder the ajmo skill named in `checkout`, else `head`.
  const checkoutOf = (scratch: string): string => path.join(scratch, readText(path.join(scratch, 'checkout'))?.trim() || 'head');

  function findPrs(): Map<string, PrRef[]> {
    const out = new Map<string, PrRef[]>();
    const tasks = new Map<string, Map<string, string>>();
    const read = readText;
    const tasksOf = (scratch: string): Map<string, string> => {
      let found = tasks.get(scratch);
      if (!found) { found = tasksIn(scratch); tasks.set(scratch, found); }
      return found;
    };
    for (const s of sessions) {
      if (!s.cwd) continue;
      const dir = skills.repoRoot(s.cwd);
      const refs: PrRef[] = [];
      const review = reviewOf(s, dir);
      if (review) {
        const url = read(path.join(review.scratch, 'pr.url'))?.trim();
        refs.push({ label: `#${review.n}`, dir, number: review.n, url: url && /^https?:\/\//.test(url) ? url : undefined });
      } else {
        const task = taskOf(s, dir, tasksOf);
        for (const url of task ? skills.taskPrUrls(read(path.join(task, 'task.json')) ?? '') : []) {
          refs.push({ label: url.replace(/^https?:\/\/[^/]+\//, ''), dir, url });
        }
      }
      if (refs.length > 0) out.set(model.sessionKey(s), refs);
    }
    return out;
  }

  // The folder a session works in: a review's checkout of the PR head, a task
  // unit's worktree, the session's own worktree, otherwise the repository.
  // It opens in a separate VS Code window as a plain folder, so search, git and
  // TypeScript see exactly that code; a folder that is already open in some
  // window is focused instead of opened twice.
  async function openCode(s: Session): Promise<void> {
    if (!s.cwd) { vscode.window.showInformationMessage(`Ajmo: "${s.name || s.id}" has no folder.`); return; }
    const root = skills.repoRoot(s.cwd);
    let dirs: { label: string; dir: string }[] = [];
    const review = reviewOf(s, root);
    if (review) dirs = [{ label: `PR #${review.n}`, dir: checkoutOf(review.scratch) }];
    else {
      const task = taskOf(s, root);
      if (task) dirs = skills.taskWorktrees(readText(path.join(task, 'task.json')) ?? '');
    }
    dirs = dirs.filter((d) => fs.existsSync(d.dir));
    if (dirs.length === 0) dirs = [{ label: path.basename(s.cwd), dir: fs.existsSync(s.cwd) ? s.cwd : root }];
    let target = dirs[0];
    if (dirs.length > 1) {
      target = (await vscode.window.showQuickPick(dirs.map((d) => ({ label: d.label, description: d.dir, d })),
        { placeHolder: 'Which worktree to open' }))?.d;
    }
    if (!target) return;
    void vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(target.dir), { forceNewWindow: true });
  }

  function run(cmd: string, args: string[], cwd: string): Promise<string> {
    return new Promise((resolve) => {
      cp.execFile(cmd, args, { cwd, env: execEnv(), timeout: 15000 }, (err, stdout) => resolve(err ? '' : stdout.trim()));
    });
  }

  async function openPr(s: Session): Promise<void> {
    const refs = prs.get(model.sessionKey(s)) ?? [];
    let ref = refs[0];
    if (refs.length > 1) {
      ref = (await vscode.window.showQuickPick(refs.map((r) => ({ label: r.label, ref: r })), { placeHolder: 'Which PR to open' }))?.ref;
    }
    if (!ref) { if (refs.length === 0) vscode.window.showInformationMessage(`Ajmo: no PR found for "${s.name || s.id}".`); return; }
    let url = ref.url;
    if (!url && ref.number !== undefined) {
      // gh knows the right repository even when origin is a fork; the remote URL is the fallback.
      const viaGh = await run('gh', ['pr', 'view', String(ref.number), '--json', 'url', '-q', '.url'], ref.dir);
      url = /^https?:\/\//.test(viaGh) ? viaGh
        : skills.prUrlFromRemote(await run('git', ['remote', 'get-url', 'origin'], ref.dir), ref.number) ?? undefined;
    }
    if (url) void vscode.env.openExternal(vscode.Uri.parse(url));
    else vscode.window.showErrorMessage(`Ajmo: could not work out the PR URL for "${s.name || s.id}".`);
  }

  // New session: pick a repository, type the prompt, run `claude --bg` there.
  // The session then appears in the list and its terminal opens.
  async function newSession(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const isRepo = (dir: string): boolean => fs.existsSync(path.join(dir, '.git'));
    const root = model.launchDir(cfg().get('launchDirectory', ''), folder, Boolean(folder) && isRepo(folder as string), os.homedir());
    let children: string[] = [];
    try {
      children = fs.readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory()).map((e) => path.join(root, e.name)).filter(isRepo);
    } catch { /* an unreadable root leaves only repositories known from sessions */ }
    const home = os.homedir();
    const picks = model.repoChoices(children, sessions).map((r) => ({
      label: r.name, description: r.dir.startsWith(home) ? `~${r.dir.slice(home.length)}` : r.dir, repo: r,
    }));
    if (picks.length === 0) { vscode.window.showErrorMessage(`Ajmo: no git repositories found in ${root}.`); return; }
    const pick = await vscode.window.showQuickPick(picks, { title: 'New session', placeHolder: 'Repository', matchOnDescription: true });
    if (!pick) return;
    const prompt = await askPrompt(pick.repo.name, await loadSkills(pick.repo.dir));
    if (!prompt?.trim()) return;
    const bin = cfg().get('claudePath', 'claude');
    cp.execFile(bin, ['--bg', '--', prompt.trim()], { cwd: pick.repo.dir, env: execEnv(), timeout: 60000 }, (err, stdout, stderr) => {
      if (err) {
        vscode.window.showErrorMessage(`Ajmo: could not start a session in ${pick.repo.name}: ${String(stderr || err.message).trim().split('\n').pop()}`);
        return;
      }
      const id = model.startedSessionId(stdout);
      if (id) pendingOpen = { id, until: Date.now() + 30000 };
      poll();
    });
  }

  let timer: NodeJS.Timeout | undefined;
  function schedule(): void {
    clearInterval(timer);
    timer = setInterval(poll, Math.max(1, cfg().get('pollSeconds', 3)) * 1000);
  }


  context.subscriptions.push(
    tree, bar,
    { dispose: () => clearInterval(timer) },
    { dispose: () => windows.remove() },
    vscode.workspace.onDidChangeWorkspaceFolders(() => windows.publish()),
    vscode.window.tabGroups.onDidChangeTabs(updateActive),
    vscode.window.tabGroups.onDidChangeTabGroups(updateActive),
    vscode.window.onDidChangeActiveTerminal(updateActive),
    // Coming back to the window with a session tab active counts as seeing it.
    vscode.window.onDidChangeWindowState((e) => { if (e.focused && seeActive()) render(); }),
    // The panel was opened after the tab changed: set the selection now.
    tree.onDidChangeVisibility((e) => { if (e.visible) { syncedKey = null; updateActive(); } }),
    tree.onDidCollapseElement((e) => setCollapsed(e.element, true)),
    tree.onDidExpandElement((e) => setCollapsed(e.element, false)),
    vscode.commands.registerCommand('ajmo.refresh', poll),
    vscode.commands.registerCommand('ajmo.newSession', newSession),
    vscode.commands.registerCommand('ajmo.find', findSession),
    vscode.commands.registerCommand('ajmo.filter', chooseFilter),
    vscode.commands.registerCommand('ajmo.clearFilter', () => setFilter(model.NO_FILTER)),
    vscode.window.registerWebviewViewProvider(FilterView.id, filterView),
    vscode.commands.registerCommand('ajmo.open', (el?: Node) => {
      if (el?.type === 'session') openSession(el.item.session);
    }),
    vscode.commands.registerCommand('ajmo.markAllSeen', () => {
      const records = store.read() || {};
      let changed = false;
      for (const key of Object.keys(records)) changed = model.markSeen(records, key) || changed;
      if (changed) store.write(records);
      render();
    }),
    vscode.commands.registerCommand('ajmo.nextWaiting', openNextWaiting),
    ...Object.entries({
      'ajmo.openPr': openPr,
      'ajmo.openCode': openCode,
      'ajmo.delete': deleteSession,
      'ajmo.markSeen': (s: Session) => setSeen(s, true),
      'ajmo.markUnseen': (s: Session) => setSeen(s, false),
    }).map(([id, act]) => vscode.commands.registerCommand(id, (el?: Node) => { if (el?.type === 'session') void act(el.item.session); })),
    vscode.commands.registerCommand('ajmo.copyId', (el?: Node) => {
      if (el?.type === 'session') vscode.env.clipboard.writeText(model.sessionKey(el.item.session));
    }),
    vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration('ajmo')) { schedule(); render(); } }),
  );

  schedule();
  poll();
  activateReview(context, execEnv);
}

export function deactivate(): void {}
