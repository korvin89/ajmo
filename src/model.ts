// model.ts — pure panel logic: no vscode, covered by tests.
import * as path from 'node:path';
import { prNumber, repoRoot } from './skills.ts';

// One entry of `claude agents --json --all`. Every field is optional: the CLI
// owns the format and it changes.
export interface Session {
  id?: string;
  sessionId?: string;
  cwd?: string;
  kind?: string;
  name?: string;
  startedAt?: number;
  pid?: number;
  status?: string;
  state?: string;
  waitingFor?: string;
}

export type Cls = 'waiting' | 'failed' | 'working' | 'stopped' | 'done' | 'unknown';

export interface SessionRecord {
  cls: Cls;
  changedAt: number | null;
  seen: boolean;
}

// sessionId (or id) → record.
export type Records = Record<string, SessionRecord>;

export interface TrackEvent {
  session: Session;
  cls: Cls;
}

export interface Item {
  session: Session;
  key: string;
  cls: Cls;
  seen: boolean;
  changedAt: number | null;
}

export interface Group {
  repo: string;
  items: Item[];
  attention: number;
}

export interface Counts {
  waiting: number;
  failed: number;
  unseen: number;
  working: number;
}

// List mode. all — the default, every session; attention — only what needs
// attention; working — sessions where the agent is working right now.
export type Filter = 'all' | 'attention' | 'working';

export const FILTER_LABELS: Record<Filter, string> = {
  all: 'All',
  attention: 'Needs attention',
  working: 'Working',
};

export interface FilterState {
  mode: Filter;
  // Search query: every word must occur in the name, repository, status or id.
  query: string;
}

export const NO_FILTER: FilterState = { mode: 'all', query: '' };

// filterActive — the user narrowed the list.
export function filterActive(f: FilterState): boolean {
  return f.mode !== 'all' || f.query.trim() !== '';
}

export interface View {
  groups: Group[];
  // How many sessions the filter removed.
  filtered: number;
  shown: number;
  total: number;
  counts: Counts;
}

const WAITING_LABELS: Record<string, string> = {
  'permission prompt': 'permission',
  'input needed': 'needs input',
  'sandbox request': 'sandbox request',
  'worker request': 'worker request',
  'dialog open': 'dialog open',
};

export function sessionKey(s: Session): string {
  return s.sessionId || s.id || '';
}

// classify — which of our classes a session from `claude agents --json` falls
// into. Fields used: state ("done", "blocked", …), status ("busy", "waiting",
// "idle"; present only while the process is alive), waitingFor.
// `state` is the agent's own turn and wins over `status`, which is about the
// process: a session whose agent has finished but which still runs a
// background shell (a listener, a watcher) is `busy` and `done`, and it is
// done. Only a session with no `state` (an interactive one) is judged by
// `status` alone.
export function classify(s: Session): Cls {
  const state = String(s.state || '').toLowerCase();
  const status = String(s.status || '').toLowerCase();
  if (state === 'blocked' || status === 'waiting' || s.waitingFor) return 'waiting';
  if (state === 'failed' || state === 'error') return 'failed';
  if (state === 'working' || state === 'running') return 'working';
  if (state === 'stopped') return 'stopped';
  if (state === 'done' || state === 'completed') return 'done';
  if (status === 'busy') return 'working';
  if (status === 'idle') return 'done';
  return 'unknown';
}

// canAttach — whether `claude attach <id>` can open the session. An interactive
// session has no id: it lives where it was started.
export function canAttach(s: Session): boolean {
  return /^[A-Za-z0-9_-]+$/.test(String(s.id || ''));
}

// A VS Code window running the panel: what it has open and how to open it.
export interface WindowInfo {
  pid: number;
  // Folder or workspace file URI for vscode.openFolder; null — nothing to open it with.
  target: string | null;
  folders: string[];
}

function inside(dir: string, folder: string): boolean {
  const rel = path.relative(folder, dir);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// findWindow — another VS Code window that has the session folder open. null
// when the folder is open in this window (ownPid) or nowhere. With several
// matching windows the deepest folder wins.
export function findWindow(windows: WindowInfo[], cwd: string | undefined, ownPid: number): WindowInfo | null {
  if (!cwd) return null;
  let best: WindowInfo | null = null;
  let bestLen = -1;
  for (const w of windows) {
    for (const f of w.folders) {
      if (!inside(cwd, f)) continue;
      if (w.pid === ownPid) return null;
      if (w.target && f.length > bestLen) { best = w; bestLen = f.length; }
    }
  }
  return best;
}

// Process snapshot: parents and running `claude attach <session>` commands.
export interface Procs {
  parents: Map<number, number>;
  attaches: { pid: number; target: string }[];
}

// parsePs — parses `ps -axo pid=,ppid=,args=` output.
export function parsePs(text: string): Procs {
  const parents = new Map<number, number>();
  const attaches: Procs['attaches'] = [];
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)(?:\s+(.*))?$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    parents.set(pid, Number(m[2]));
    const a = /claude\S*\s+attach\s+(\S+)/.exec(m[3] || '');
    if (a?.[1]) attaches.push({ pid, target: a[1] });
  }
  return { parents, attaches };
}

function descends(pid: number | undefined, ancestor: number, parents: Map<number, number>): boolean {
  const seen = new Set<number>();
  let cur = pid;
  while (cur !== undefined && cur > 1 && !seen.has(cur)) {
    if (cur === ancestor) return true;
    seen.add(cur);
    cur = parents.get(cur);
  }
  return false;
}

// launchDir — the folder whose child repositories are offered for a new
// session: a folder of repositories as is, the parent of a workspace folder
// that is itself a repository (so its siblings are offered too). An explicit
// setting wins.
export function launchDir(setting: string, workspaceFolder: string | undefined, isRepo: boolean, home: string): string {
  const s = setting.trim();
  if (s) return s === '~' ? home : s.startsWith('~/') ? path.join(home, s.slice(2)) : s;
  if (!workspaceFolder) return home;
  return isRepo ? path.dirname(workspaceFolder) : workspaceFolder;
}

export interface RepoChoice {
  name: string;
  dir: string;
}

// repoChoices — where a new session can start: the given repository folders
// plus the repositories that already have sessions, by name.
export function repoChoices(repoDirs: string[], sessions: Session[]): RepoChoice[] {
  const byDir = new Map<string, RepoChoice>();
  const add = (dir: string): void => { if (!byDir.has(dir)) byDir.set(dir, { name: path.basename(dir), dir }); };
  for (const dir of repoDirs) add(dir.replace(/[\\/]+$/, ''));
  for (const s of sessions) if (s.cwd) add(repoRoot(s.cwd));
  return [...byDir.values()].sort((a, b) => a.name.localeCompare(b.name) || a.dir.localeCompare(b.dir));
}

export interface SkillCommand {
  // What the user types, with the leading slash: `/name` or `/plugin:name`.
  command: string;
  description: string;
}

// parseSkill — reads the frontmatter of a SKILL.md or a command .md file.
// Handles only what these files use: `key: value`, quoted values and block
// scalars (`>-`, `|`). Returns null for a skill the user cannot invoke.
export function parseSkill(text: string, fallbackName: string, plugin?: string): SkillCommand | null {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '';
  const fields: Record<string, string> = {};
  let key = '';
  for (const line of fm.split(/\r?\n/)) {
    const m = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (m?.[1]) {
      key = m[1];
      const raw = (m[2] ?? '').trim();
      fields[key] = /^[>|][+-]?$/.test(raw) ? '' : raw.replace(/^(["'])(.*)\1$/, '$2');
    } else if (key && /^\s+\S/.test(line)) {
      fields[key] = `${fields[key] ?? ''} ${line.trim()}`.trim();
    }
  }
  if (fields['user-invocable'] === 'false') return null;
  const name = fields.name || fallbackName;
  if (!name) return null;
  return { command: `/${plugin ? `${plugin}:` : ''}${name}`, description: fields.description ?? '' };
}

// sortSkills — unique commands by name; an earlier entry wins a duplicate.
export function sortSkills(skills: SkillCommand[]): SkillCommand[] {
  const seen = new Map<string, SkillCommand>();
  for (const s of skills) if (!seen.has(s.command)) seen.set(s.command, s);
  return [...seen.values()].sort((a, b) => a.command.localeCompare(b.command));
}

// isPickingSkill — the prompt so far is an unfinished slash command, so skill
// suggestions apply. Once there is a space the user is writing the task.
export function isPickingSkill(prompt: string): boolean {
  return /^\/\S*$/.test(prompt);
}

// brief — a description cut to one line for a suggestion row.
export function brief(text: string, max = 110): string {
  const one = text.replace(/\s+/g, ' ').trim();
  const sentence = /^.*?[.!?](?=\s|$)/.exec(one)?.[0] ?? one;
  return sentence.length > max ? `${sentence.slice(0, max - 1).trimEnd()}…` : sentence;
}

// startedSessionId — the short id `claude --bg` prints for the new session.
export function startedSessionId(stdout: string): string | null {
  return /\b[0-9a-f]{8}\b/.exec(stdout)?.[0] ?? null;
}

// terminalSessionKey — which session runs in the terminal whose shell is
// shellPid: a background one that `claude attach` is connected to there, or an
// interactive one started right in it. The terminal name is no evidence:
// claude changes it, and the name the panel set is lost on window reload.
export function terminalSessionKey(sessions: Session[], shellPid: number | undefined, procs: Procs): string | null {
  if (!shellPid) return null;
  for (const a of procs.attaches) {
    if (!descends(a.pid, shellPid, procs.parents)) continue;
    const byId = sessions.find((s) => s.id === a.target);
    if (byId) return sessionKey(byId);
    // attach also accepts a part of the session name.
    const byName = sessions.filter((s) => canAttach(s) && s.name?.includes(a.target));
    if (byName.length === 1 && byName[0]) return sessionKey(byName[0]);
  }
  const own = sessions.find((s) => s.kind === 'interactive' && descends(s.pid, shellPid, procs.parents));
  return own ? sessionKey(own) : null;
}

// ownerWindow — which VS Code window runs the session process. The Claude Code
// extension chat spawns claude as a descendant of its window's extension host,
// and that host's pid is WindowInfo.pid. null — the session does not come from
// the extension chat (for example, from a terminal).
export function ownerWindow(windows: WindowInfo[], pid: number | undefined, parents: Map<number, number>): WindowInfo | null {
  const seen = new Set<number>();
  let cur = pid;
  while (cur !== undefined && cur > 1 && !seen.has(cur)) {
    seen.add(cur);
    const w = windows.find((x) => x.pid === cur);
    if (w) return w;
    cur = parents.get(cur);
  }
  return null;
}

// terminalLabel — a short tab name for a session terminal: "repo #number" for
// a PR, the ticket key for a task, otherwise the session name. It need not be
// unique: the panel identifies a terminal's session by processes.
export function terminalLabel(s: Session): string {
  const name = s.name || '';
  const pr = prNumber(name);
  if (pr !== null) return `${repoOf(s.cwd)} #${pr}`;
  const ticket = /\b([a-z][a-z0-9]+)-(\d{3,})\b/i.exec(name);
  if (ticket) return `${ticket[1]}-${ticket[2]}`.toUpperCase();
  return name || 'claude';
}

// terminalRename — the name to give back to a session terminal, or null when
// it already has it. VS Code loses the name the panel set on window reload.
export function terminalRename(s: Session | undefined, current: string): string | null {
  if (!s || !canAttach(s)) return null;
  const want = terminalLabel(s);
  return want === current ? null : want;
}

// The window's active tab as far as sessions are concerned: a terminal or a
// Claude Code extension chat.
export type ActiveTab =
  // sessionKey — the terminal's session found by processes (terminalSessionKey).
  | { kind: 'terminal'; label: string; sessionKey?: string | null }
  | { kind: 'chat'; label: string };

// activeSessionKey — which session the user is looking at right now. The
// caller resolves a terminal's session (by processes). A chat tab does not
// expose its session id, so we take this window's chat session (ownChat —
// keys of sessions started by the extension chat in this window) with the
// same name, or the only one if there is just one.
export function activeSessionKey(sessions: Session[], tab: ActiveTab | null, ownChat: ReadonlySet<string>): string | null {
  if (!tab) return null;
  if (tab.kind === 'terminal') {
    return tab.sessionKey && sessions.some((x) => sessionKey(x) === tab.sessionKey) ? tab.sessionKey : null;
  }
  const own = sessions.filter((x) => ownChat.has(sessionKey(x)));
  const byName = own.filter((x) => x.name === tab.label);
  if (byName.length === 1 && byName[0]) return sessionKey(byName[0]);
  return own.length === 1 && own[0] ? sessionKey(own[0]) : null;
}

// repoOf — the group name. A session in `<repo>.worktrees/<branch>` or in
// Claude Code's own worktree `<repo>/.claude/worktrees/<name>` belongs to <repo>.
export function repoOf(cwd: string | undefined): string {
  if (!cwd) return '(no folder)';
  const dir = cwd.replace(/[\\/]+$/, '');
  const own = /^(.*?)[\\/]\.claude[\\/]worktrees[\\/]/.exec(dir + path.sep);
  if (own?.[1]) return path.basename(own[1]);
  const parent = path.basename(path.dirname(dir));
  if (parent.endsWith('.worktrees')) return parent.slice(0, -'.worktrees'.length);
  return path.basename(dir) || dir;
}

// track — compares a poll with the previous one. Returns the new records and
// the transitions worth reporting. On the very first poll (records === null)
// everything counts as seen: otherwise every existing session would turn
// "unseen" right after install.
export function track(records: Records | null, sessions: Session[], now: number): { records: Records; events: TrackEvent[] } {
  const initial = records === null;
  const prev = records || {};
  const next: Records = {};
  const events: TrackEvent[] = [];
  for (const s of sessions) {
    const key = sessionKey(s);
    if (!key) continue;
    const cls = classify(s);
    const old = prev[key];
    if (!old) {
      const quiet = initial || cls === 'working' || cls === 'unknown';
      next[key] = { cls, changedAt: initial ? null : now, seen: quiet };
      if (!initial && (cls === 'waiting' || cls === 'failed')) events.push({ session: s, cls });
    } else if (old.cls !== cls) {
      const quiet = cls === 'working' || cls === 'unknown';
      next[key] = { cls, changedAt: now, seen: quiet };
      if (cls === 'waiting' || cls === 'failed' || cls === 'done') events.push({ session: s, cls });
    } else {
      next[key] = old;
    }
  }
  return { records: next, events };
}

export function markSeen(records: Records | null, key: string): boolean {
  const rec = records?.[key];
  if (!records || !rec || rec.seen) return false;
  records[key] = { ...rec, seen: true };
  return true;
}

// markUnseen — puts the "unseen" mark back on a finished session.
export function markUnseen(records: Records | null, key: string): boolean {
  const rec = records?.[key];
  if (!records || !rec || !rec.seen || rec.cls !== 'done') return false;
  records[key] = { ...rec, seen: false };
  return true;
}

export function needsAttention(cls: Cls, seen: boolean): boolean {
  return cls === 'waiting' || cls === 'failed' || (cls === 'done' && !seen);
}

function rank(cls: Cls, seen: boolean): number {
  if (cls === 'waiting') return 0;
  if (cls === 'failed') return 1;
  if (cls === 'done' && !seen) return 2;
  if (cls === 'working') return 3;
  if (cls === 'unknown') return 4;
  if (cls === 'stopped') return 5;
  return 6;
}

function matchesMode(mode: Filter, s: Session, cls: Cls, seen: boolean): boolean {
  if (mode === 'attention') return needsAttention(cls, seen);
  if (mode === 'working') return cls === 'working';
  return true;
}

function matchesQuery(words: string[], s: Session, repo: string, label: string): boolean {
  if (words.length === 0) return true;
  const text = [s.name, repo, label, s.id, s.sessionId].filter(Boolean).join(' ').toLowerCase();
  return words.every((w) => text.includes(w));
}

export interface ModeFacet {
  id: Filter;
  label: string;
  // What exactly the mode shows — for the tooltip.
  hint: string;
  count: number;
}

// modeFacets — the list modes and how many sessions each one shows.
export function modeFacets(sessions: Session[], records: Records | null): ModeFacet[] {
  const hints: Record<Filter, string> = {
    all: 'All sessions',
    attention: 'Waiting for your answer, failed, or finished and not seen yet',
    working: 'Sessions where the agent is working right now',
  };
  return (Object.keys(FILTER_LABELS) as Filter[]).map((id) => ({
    id, label: FILTER_LABELS[id], hint: hints[id],
    count: buildGroups(sessions, records, { mode: id }).shown,
  }));
}

export interface FlatItem extends Item {
  repo: string;
}

// flatten — all sessions as one list for search: those needing attention
// first, then working ones, then the rest; newer first within each.
export function flatten(view: View): FlatItem[] {
  const out: FlatItem[] = [];
  for (const g of view.groups) for (const item of g.items) out.push({ ...item, repo: g.repo });
  out.sort((a, b) => rank(a.cls, a.seen) - rank(b.cls, b.seen)
    || (b.session.startedAt || 0) - (a.session.startedAt || 0));
  return out;
}

// nextAttention — the session to jump to: the one after the active session
// among those needing attention (waiting first, then failed, then unseen),
// wrapping around. null when nobody needs attention.
export function nextAttention(sessions: Session[], records: Records | null, activeKey: string | null): Session | null {
  const queue = flatten(buildGroups(sessions, records, { mode: 'attention' }));
  if (queue.length === 0) return null;
  const at = queue.findIndex((i) => i.key === activeKey);
  return (queue[(at + 1) % queue.length] as FlatItem).session;
}

// buildGroups — what the tree shows: sessions passing the mode and the search
// query, grouped by repository. The order is static: repositories by name,
// sessions newest first.
export function buildGroups(sessions: Session[], records: Records | null, filter: Partial<FilterState> = {}): View {
  const f: FilterState = { ...NO_FILTER, ...filter };
  const words = f.query.toLowerCase().split(/\s+/).filter(Boolean);
  const recs = records || {};
  const byRepo = new Map<string, Item[]>();
  let filtered = 0;
  const counts: Counts = { waiting: 0, failed: 0, unseen: 0, working: 0 };
  for (const s of sessions) {
    const key = sessionKey(s);
    const cls = classify(s);
    const rec = recs[key] || { cls, changedAt: null, seen: true };
    const seen = rec.seen !== false;
    if (cls === 'waiting') counts.waiting++;
    else if (cls === 'failed') counts.failed++;
    else if (cls === 'working') counts.working++;
    else if (cls === 'done' && !seen) counts.unseen++;
    const repo = repoOf(s.cwd);
    if (!matchesMode(f.mode, s, cls, seen)
      || !matchesQuery(words, s, repo, statusLabel({ cls, session: s, seen }))) { filtered++; continue; }
    let items = byRepo.get(repo);
    if (!items) { items = []; byRepo.set(repo, items); }
    items.push({ session: s, key, cls, seen, changedAt: rec.changedAt });
  }
  const groups: Group[] = [];
  for (const [repo, items] of byRepo) {
    // The order never depends on status, so rows do not jump when a session
    // changes state or gets seen: newest first, the key breaks ties.
    items.sort((a, b) => (b.session.startedAt || 0) - (a.session.startedAt || 0) || a.key.localeCompare(b.key));
    groups.push({ repo, items, attention: items.filter((i) => needsAttention(i.cls, i.seen)).length });
  }
  groups.sort((a, b) => a.repo.localeCompare(b.repo));
  const total = sessions.length;
  return { groups, filtered, shown: total - filtered, total, counts };
}

export function statusLabel(item: { cls: Cls; session: Session; seen?: boolean }): string {
  const s = item.session;
  switch (item.cls) {
    case 'waiting': return WAITING_LABELS[String(s.waitingFor || '').toLowerCase()] || s.waitingFor || 'waiting for you';
    case 'failed': return 'failed';
    case 'working': return 'working';
    case 'stopped': return 'stopped';
    case 'done': return item.seen ? 'done' : 'done, unseen';
    default: return s.state || s.status || 'unknown';
  }
}

// describe — the row description: status, interactive mark, time.
export function describe(item: Item, now: number): string {
  const kind = item.session.kind === 'interactive' ? 'interactive' : '';
  return [statusLabel(item), kind, timeLabel(item, now)].filter(Boolean).join(' · ');
}

export function ago(ms: number): string {
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h`;
  return `${Math.floor(h / 24)} d`;
}

// timeLabel — how long the session has been in this state if we saw the
// transition; otherwise only when it started: claude reports no other time.
export function timeLabel(item: { changedAt?: number | null; session: Session }, now: number): string {
  if (item.changedAt) return ago(now - item.changedAt);
  if (typeof item.session.startedAt === 'number') {
    const age = now - item.session.startedAt;
    return age < 60000 ? 'started just now' : `started ${ago(age)} ago`;
  }
  return '';
}
