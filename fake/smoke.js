// Smoke run of the built extension with a vscode stub and a fake claude.
const Module = require('module'); const path = require('path'); const fs = require('fs'); const os = require('os');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-'));
const saved = {}; const shown = []; const terms = []; const cmds = {};
const settings = { claudePath: path.join(__dirname, 'claude'), pollSeconds: 1, notifyOnDone: true };
class EventEmitter { constructor(){ this.l=[]; this.event=(f)=>this.l.push(f);} fire(x){ this.l.forEach(f=>f(x)); } }
const vscode = {
  EventEmitter, TreeItem: class { constructor(label, st){ this.label=label; this.collapsibleState=st; } },
  TreeItemCollapsibleState: { Collapsed: 1, Expanded: 2 }, ThemeIcon: class { constructor(id,c){ this.id=id; this.color=c; } },
  ThemeColor: class { constructor(id){ this.id=id; } },
  MarkdownString: class { constructor(){ this.value=''; } appendMarkdown(s){ this.value+=s; } appendCodeblock(s){ this.value+='```\n'+s+'\n```\n'; } },
  TabInputTerminal: class {}, TabInputWebview: class {},
  StatusBarAlignment: { Left: 1 }, TerminalLocation: { Editor: 2, Panel: 1 },
  workspace: { workspaceFolders: [], onDidChangeWorkspaceFolders: () => ({ dispose(){} }), getConfiguration: () => ({ get: (k, d) => (k in settings ? settings[k] : d) }), onDidChangeConfiguration: () => ({ dispose(){} }) },
  Uri: { file: (p) => ({ fsPath: p }), parse: (u) => ({ url: u }), joinPath: (base, ...parts) => ({ fsPath: path.join(base.fsPath, ...parts) }) },
  env: { clipboard: { writeText(){} } },
  QuickPickItemKind: { Separator: -1 },
  commands: { executeCommand: async (id, k, v) => { if (id === 'setContext') vscode._ctx = { ...vscode._ctx, [k]: v }; if (id === 'vscode.openFolder') vscode._opened = [k.fsPath, v];  }, registerCommand: (id, f) => { cmds[id]=f; return { dispose(){} }; } },
  window: {
    state: { focused: true }, terminals: terms,
    tabGroups: { all: [], activeTabGroup: { activeTab: undefined, viewColumn: 1 }, onDidChangeTabs: (f) => { vscode._tabs = f; return { dispose(){} }; }, onDidChangeTabGroups: () => ({ dispose(){} }) },
    activeTerminal: undefined, onDidChangeActiveTerminal: () => ({ dispose(){} }),
    createTreeView: (id, o) => (vscode._tree = { provider: o.treeDataProvider, visible: true, onDidCollapseElement: (f) => { vscode._collapse = f; return { dispose(){} }; }, onDidExpandElement: (f) => { vscode._expand = f; return { dispose(){} }; }, onDidChangeVisibility: () => ({ dispose(){} }), reveal: async (n, opt) => { vscode._revealed = [n.item.session.name, opt]; }, dispose(){} }),
    createStatusBarItem: () => (vscode._bar = { show(){}, dispose(){} }),
    showInformationMessage: (t) => { shown.push(t); return Promise.resolve(undefined); },
    showWarningMessage: (t) => { shown.push('WARN ' + t); return Promise.resolve(undefined); },
    registerWebviewViewProvider: (id, prov) => { vscode._filter = prov; return { dispose(){} }; },
    showQuickPick: async (items) => { console.log('quick pick:', items.map((i) => `${i.label} — ${i.description}`)); return items.find((i) => /Needs attention|Date time|^charts$/.test(i.label)); },
    createQuickPick: () => { const q = { value: '', items: [], selectedItems: [], activeItems: [], onDidChangeValue(f) { q.change = f; }, onDidAccept(f) { q.accept = f; }, onDidHide(f) { q.hidden = f; }, show() { vscode._qp = q; }, hide() { q.hidden(); }, dispose() {},
      type(v) { q.value = v; q.change(v); q.activeItems = q.items.filter((i) => i.alwaysShow || i.label.includes(v)).slice(0, 1); }, enter() { q.accept(); } }; return q; },
    setStatusBarMessage: (t) => { shown.push('STATUS ' + t); }, onDidChangeWindowState: () => ({ dispose(){} }),
    showErrorMessage: (t) => { shown.push('ERR ' + t); },
    createTerminal: (o) => { const t = { name: o.name, opts: o, processId: Promise.resolve(undefined), sent: [], exitStatus: undefined, show(){ t.shown=(t.shown||0)+1; }, sendText(x){ t.sent.push(x); } }; terms.push(t); return t; },
  },
};
const orig = Module._load; Module._load = (r, ...a) => (r === 'vscode' ? vscode : orig(r, ...a));
const ext = require('../dist/extension.js');
const ctx = { extensionUri: { fsPath: path.join(__dirname, '..') }, globalStorageUri: { fsPath: tmp }, subscriptions: [], globalState: { get: (k, d) => (k in saved ? saved[k] : d), update: async (k, v) => { saved[k] = v; } } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dump = () => { const p = vscode._tree.provider; return p.getChildren().map((g) => { const t = p.getTreeItem(g);
  return [t.label, t.description || '', ...p.getChildren(g).map((c) => { const i = p.getTreeItem(c); return `   ${i.iconPath.id} ${i.label} [${i.contextValue}]`; })].join('\n'); }).join('\n'); };
(async () => {
  ext.activate(ctx); await sleep(600);
  console.log('--- first poll\n' + dump()); console.log('bar:', vscode._bar.text, '| badge:', JSON.stringify(vscode._tree.badge), '| msg:', vscode._tree.message);
  const out = path.join(__dirname, 'out.json'); const data = JSON.parse(fs.readFileSync(out)); const keep = JSON.stringify(data);
  data[1].status = 'waiting'; data[1].state = 'blocked'; data[1].waitingFor = 'permission prompt'; fs.writeFileSync(out, JSON.stringify(data)); await sleep(1300);
  console.log('--- session waiting\n' + dump()); console.log('bar:', vscode._bar.text, '| badge:', JSON.stringify(vscode._tree.badge));
  fs.writeFileSync(out, keep); await sleep(1300);
  console.log('--- done again\n' + dump()); console.log('bar:', vscode._bar.text, '| badge:', JSON.stringify(vscode._tree.badge));
  const p = vscode._tree.provider; const grp = p.getChildren().find((g) => g.type === 'group' && g.group.repo === 'date-components');
  cmds['ajmo.open'](p.getChildren(grp)[0]); cmds['ajmo.open'](p.getChildren(grp)[0]);
  console.log('--- after click\n' + dump()); console.log('bar:', vscode._bar.text, '| badge:', JSON.stringify(vscode._tree.badge));
  vscode.window.activeTerminal = terms[0]; vscode.window.tabGroups.activeTabGroup.activeTab = { label: terms[0].name, input: new vscode.TabInputTerminal() }; vscode._tabs();
  console.log('--- session terminal tab active\n' + dump(), '| reveal:', JSON.stringify(vscode._revealed));
  vscode.window.tabGroups.activeTabGroup.activeTab = undefined; vscode._tabs();
  console.log('terminals:', terms.map((t) => `${t.name} | ${t.sent.join(';')} | show×${t.shown} | loc=${t.opts.location}`));
  console.log('notifications:', shown);
  await cmds['ajmo.find'](); await cmds['ajmo.filter']();
  console.log('--- filter: needs attention\n' + dump(), '| description:', vscode._tree.description, '| msg:', vscode._tree.message, '| ctx:', JSON.stringify(vscode._ctx));
  const posted = []; let recv;
  vscode._filter.resolveWebviewView({ webview: { set html(h) { vscode._html = h; }, postMessage: async (m) => { posted.push(m); }, onDidReceiveMessage: (f) => { recv = f; } }, onDidDispose() {} });
  recv({ type: 'ready' }); recv({ type: 'reset' }); recv({ type: 'set', patch: { query: 'uikit' } });
  const last = posted[posted.length - 1].state;
  console.log('--- search uikit from the block above the list\n' + dump(), '| html:', vscode._html.length, '| state:', JSON.stringify({ filter: last.filter, modes: last.modes.map((x) => x.label + ' ' + x.count) }));
  recv({ type: 'reset' });
  const g0 = vscode._tree.provider.getChildren()[0]; vscode._collapse({ element: g0 });
  console.log('--- collapsed', g0.group.repo, '| state:', vscode._tree.provider.getTreeItem(vscode._tree.provider.getChildren()[0]).collapsibleState, '| saved:', JSON.stringify(saved.collapsedRepos));
  vscode._expand({ element: g0 }); console.log('--- expanded | saved:', JSON.stringify(saved.collapsedRepos));
  const started = cmds['ajmo.newSession'](); await sleep(1500); const q = vscode._qp;
  q.type('/gravity'); console.log('--- new session:', q.title, '| skills total:', q.items.length, '| match:', q.activeItems.map((i) => i.label));
  q.enter(); console.log('after picking a skill:', JSON.stringify(q.value), '| rows:', q.items.length);
  q.type(q.value + 'bump uikit'); console.log('row:', q.items.map((i) => `${i.label} — ${i.description}`)); q.enter(); await started; await sleep(300);
  const row = p.getChildren(p.getChildren().find((g) => g.type === 'group' && g.group.repo === 'date-components'))[0];
  console.log('--- tooltip:', p.getTreeItem(row).tooltip);
  await cmds['ajmo.openCode'](row); console.log('--- open code:', JSON.stringify(vscode._opened));
  cmds['ajmo.nextWaiting'](); console.log('--- next waiting:', shown[shown.length - 1]);
  cmds['ajmo.markUnseen'](row); console.log('--- marked unseen:', p.getTreeItem(p.getChildren(p.getChildren().find((g) => g.group.repo === 'date-components'))[0]).contextValue, '| bar:', vscode._bar.text, '| command:', vscode._bar.command);
  settings.claudePath = '/nonexistent/claude'; await sleep(1300); console.log('error:', vscode._tree.message);
  ctx.subscriptions.forEach((d) => d.dispose && d.dispose()); fs.writeFileSync(out, keep); process.exit(0);
})();
