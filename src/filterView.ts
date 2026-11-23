// filterView.ts — the "Search & Filter" block above the list: a search box and
// filter buttons. The list itself stays a VS Code tree; this block only changes
// the filter.
import * as vscode from 'vscode';
import type { FilterState, ModeFacet } from './model.ts';

export interface FilterViewState {
  filter: FilterState;
  modes: ModeFacet[];
  active: boolean;
  shown: number;
  total: number;
}

type Incoming =
  | { type: 'ready' }
  | { type: 'set'; patch: Partial<FilterState> }
  | { type: 'reset' };

export class FilterView implements vscode.WebviewViewProvider {
  static readonly id = 'ajmo.filter';
  private view: vscode.WebviewView | undefined;
  private state: FilterViewState | undefined;
  private readonly onPatch: (patch: Partial<FilterState>) => void;
  private readonly onReset: () => void;

  constructor(onPatch: (patch: Partial<FilterState>) => void, onReset: () => void) {
    this.onPatch = onPatch;
    this.onReset = onReset;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = html();
    view.webview.onDidReceiveMessage((msg: Incoming) => {
      if (msg.type === 'ready') this.post();
      else if (msg.type === 'set') this.onPatch(msg.patch);
      else if (msg.type === 'reset') this.onReset();
    });
    view.onDidDispose(() => { this.view = undefined; });
  }

  update(state: FilterViewState): void { this.state = state; this.post(); }

  private post(): void {
    if (this.view && this.state) void this.view.webview.postMessage({ type: 'state', state: this.state });
  }
}

function html(): string {
  const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
  html, body { height: 100%; margin: 0; overflow: hidden; }
  /* A view is never shorter than 120px while the content needs less: spread the extra between rows. */
  body { box-sizing: border-box; padding: 8px 12px; display: flex; flex-direction: column;
    gap: clamp(6px, calc((100vh - 82px) / 2), 14px); font: var(--vscode-font-size) var(--vscode-font-family); color: var(--vscode-foreground); }
  input { width: 100%; box-sizing: border-box; padding: 3px 6px; font: inherit;
    color: var(--vscode-input-foreground); background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; outline: none; }
  input:focus { border-color: var(--vscode-focusBorder); }
  input::placeholder { color: var(--vscode-input-placeholderForeground); }
  .row { display: flex; flex-wrap: wrap; gap: 4px; }
  button { font: inherit; font-size: 0.9em; line-height: 20px; height: 22px; box-sizing: border-box; padding: 0 7px; cursor: pointer; border-radius: 3px;
    display: flex; min-width: 0; white-space: nowrap;
    color: var(--vscode-foreground); background: transparent;
    border: 1px solid var(--vscode-widget-border, var(--vscode-contrastBorder, rgba(128,128,128,.45))); }
  button:hover { background: var(--vscode-toolbar-hoverBackground); }
  button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
  button[aria-pressed="true"] { color: var(--vscode-button-foreground); background: var(--vscode-button-background);
    border-color: var(--vscode-button-background); }
  button .l { overflow: hidden; text-overflow: ellipsis; }
  button .n { opacity: .7; margin-left: 6px; }
  button svg { width: 16px; height: 16px; align-self: center; flex: none; }
  button[aria-pressed="true"] svg { color: inherit; }
  #status { font-size: 0.9em; line-height: 18px; height: 18px; white-space: nowrap; overflow: hidden;
    text-overflow: ellipsis; color: var(--vscode-descriptionForeground); }
  #status.active { color: var(--vscode-foreground); }
  #reset { display: inline; height: auto; line-height: inherit; border: none; padding: 0; margin-left: 6px; border-radius: 0; font-size: 1em;
    color: var(--vscode-textLink-foreground); background: none; }
  #reset:hover { text-decoration: underline; background: none; }
</style>
</head>
<body>
  <input id="q" type="text" placeholder="Search: name, repository, status, id" aria-label="Search sessions">
  <div class="row" id="modes" role="group" aria-label="Which sessions to show"></div>
  <div id="status"></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const q = document.getElementById('q');
  const modes = document.getElementById('modes');
  const status = document.getElementById('status');
  let timer;

  q.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => vscode.postMessage({ type: 'set', patch: { query: q.value } }), 120);
  });
  q.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && q.value) { q.value = ''; vscode.postMessage({ type: 'set', patch: { query: '' } }); }
  });

  // The same icons as on list rows: pause — waiting for you, circular arrows — working.
  // Icon: [a single path, whether it is filled rather than stroked].
  const NS = 'http://www.w3.org/2000/svg';
  const ICONS = {
    attention: ['M4.5 3h2v10h-2zM9.5 3h2v10h-2z', true],
    working: ['M3.2 7.2A5 5 0 0 1 12.6 5.6M12.8 2.6v3.2H9.6M12.8 8.8A5 5 0 0 1 3.4 10.4M3.2 13.4v-3.2h3.2', false],
  };
  function icon(id) {
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('class', id);
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', ICONS[id][0]);
    if (ICONS[id][1]) path.setAttribute('fill', 'currentColor');
    else { path.setAttribute('fill', 'none'); path.setAttribute('stroke', 'currentColor'); path.setAttribute('stroke-width', '1.2'); }
    svg.append(path);
    return svg;
  }

  function chip(parent, id, label, hint, count, pressed, patch) {
    const b = document.createElement('button');
    b.title = ICONS[id] ? label + ': ' + hint.charAt(0).toLowerCase() + hint.slice(1) : hint;
    b.setAttribute('aria-label', label + ', ' + count);
    b.setAttribute('aria-pressed', String(pressed));
    if (ICONS[id]) b.append(icon(id));
    else { const l = document.createElement('span'); l.className = 'l'; l.textContent = label; b.append(l); }
    const n = document.createElement('span'); n.className = 'n'; n.textContent = String(count); b.append(n);
    b.addEventListener('click', () => vscode.postMessage({ type: 'set', patch }));
    parent.append(b);
  }

  window.addEventListener('message', (e) => {
    if (e.data.type !== 'state') return;
    const s = e.data.state;
    if (document.activeElement !== q && q.value !== s.filter.query) q.value = s.filter.query;
    modes.replaceChildren();
    // "All" is the default. Pressing an active status button again returns to it.
    for (const m of s.modes) {
      const on = m.id === s.filter.mode;
      chip(modes, m.id, m.label, m.hint, m.count, on, { mode: on ? 'all' : m.id });
    }
    status.replaceChildren();
    status.className = s.active ? 'active' : '';
    if (s.active) {
      status.append('Filtered: ' + s.shown + ' of ' + s.total);
      const reset = document.createElement('button'); reset.id = 'reset'; reset.textContent = 'clear';
      reset.addEventListener('click', () => { q.value = ''; vscode.postMessage({ type: 'reset' }); });
      status.append(reset);
    } else {
      status.append('Showing ' + s.shown + ' of ' + s.total);
    }
  });
  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
