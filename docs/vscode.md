# VS Code limits and workarounds

Read from the VS Code 1.147 bundle unless noted.

## Views

- A side bar view body is at least 120 px tall. An extension cannot change
  that or set a view's height. The filter block has three rows and spreads
  the little spare height between them (`src/filterView.ts`).
- A webview view has no codicon font unless it is bundled. The filter block
  draws its two icons as inline SVG.
- A tree does not keep collapsed rows across window reloads, and
  `TreeView.reveal` expands the parents of the row it selects. The panel stores
  collapsed repositories in globalState and calls `reveal` only when the
  active session changes, so a repository collapsed afterwards stays collapsed.
- Refreshing the tree re-renders its rows: the hover buttons of the row under
  the pointer can stay stuck on screen, and an open tooltip closes. The
  provider therefore fires a refresh only when what the rows show has changed,
  not on every poll.
- A row's "…" button is a submenu contributed to `view/item/context` in the
  `inline` group (confirmed by the user); menu groups (`1_actions`,
  `9_delete`) become separators. A menu item cannot be coloured.
- `TreeView.reveal` opens the view when it is hidden, so the panel calls it
  only while the tree is visible. A tree selection cannot be cleared from an
  extension.

## Commands

- A command's `category` ("Ajmo") is shown as a prefix only in the Command
  Palette; buttons and menus show the bare `title`. So the name goes into
  `category`, never into the title.

## Review

- A comment box scrolls inside itself past a fixed height unless the VS Code
  setting `comments.maxHeight` is `false`. The extension makes that the
  default through `contributes.configurationDefaults`; it is global, so it
  also affects other extensions' comments.
- Drawn comment threads are updated in place (`thread.comments = …`), never
  disposed and recreated: recreating them makes the editor scroll away, and
  the box VS Code opens for a new comment is kept as the thread itself.
- There is no API to reveal one comment thread (checked in the 1.146 types).
  Going to a thread from the Draft view folds the other threads on the same
  line and leaves the chosen one open.
- The Review panel watches the scratch folder (`fs.watch`) and redraws the
  threads when the agent rewrites `threads.json`. The script replaces the
  file by rename, so the watcher is on the folder, not on the file.
- A view's `badge` is summed into the number on the activity bar icon. Only
  the Sessions view sets one (agents waiting for you); the Draft view shows
  its count in the view description instead.
- The left side of a diff is served by a read-only `FileSystemProvider`
  (`git show <base>:<path>` as bytes). A `TextDocumentContentProvider` is not
  enough: the image editor reads its input as a file and fails with "The
  editor could not be opened" on a text-only scheme. The extension must be
  active before VS Code restores such a diff after a window reload, hence the
  `onFileSystem:ajmo-base` activation event next to `onStartupFinished`; the right side is the real file, which is what
  keeps go-to-definition working.
- GitHub line comments are drawn with the Comments API
  (`comments.createCommentController`), threads with `canReply = false`.
  The user's threads use a second controller with a
  `commentingRangeProvider`; the buttons under a comment box are commands
  contributed to `comments/commentThread/context`. VS Code draws the entry
  with the lowest order rightmost and as the primary button (seen in a real
  window); the others are secondary, and two equal buttons are not possible.
  Review threads come from one `gh api graphql` call (`reviewThreads`); the
  viewer's own pending comments are included with `state: PENDING`.
- The view is contributed with `when: ajmo.reviewFolder`, set when
  the window's first folder has a `.git` file, that is, is a linked worktree.
- The user confirmed the view, the diffs and image diffs in a real window.

## Icons

- A comment's avatar (`author.iconPath`) is a plain image with no theme
  variants and cannot be a codicon. The thread icons are therefore SVG copies
  of codicons in a dark and a light colour, picked by
  `window.activeColorTheme.kind`; threads are redrawn on a theme change.
- The activity bar takes an SVG and uses it as a mask: only the shape matters.
- The status bar takes only font glyphs (`$(name)`), so the logo is also
  shipped as a font and registered under `contributes.icons` as
  `ajmo-logo`; terminal tabs use it as a `ThemeIcon`.
- Rebuild the font after changing `media/ajmo.svg` (a one-off tool, not a
  project dependency; the glyph must stay at `\f101`):

      mkdir -p /tmp/f/in && cp media/ajmo.svg /tmp/f/in/
      npx --yes fantasticon@3 /tmp/f/in -o /tmp/f -n ajmo -t woff --normalize --font-height 1000
      cp /tmp/f/ajmo.woff media/

## Terminals

- A terminal named by an extension has a static title, but the first cwd
  change resets its title source. The saved state then lacks the static
  flag, and after a window reload the tab shows what `claude` reports.
- Only the active terminal can be renamed:
  `workbench.action.terminal.renameWithArg` with `{ name }`. On startup the
  panel activates each session tab in turn, renames it, then restores every
  editor group's tab with `workbench.action.focus<Nth>EditorGroup` and
  `workbench.action.openEditorAtIndex`. Bottom-panel terminals are renamed
  only when visited, because showing one would open the panel.
- A tab does not link to its `Terminal`. For a terminal tab the panel uses
  `window.activeTerminal`; the user confirmed it follows the active tab.
- A terminal whose cwd is outside the workspace folder gets the folder name
  appended to its tab (`terminal.integrated.tabs.description`, `${cwdFolder}`).
  Session terminals are therefore created without a cwd; `claude attach <id>`
  does not need one.
- Terminal names are not identity. The panel maps a terminal to a session
  through `terminal.processId` and `ps`.

## The Marketplace icon

- `package.json` `icon` must be a PNG of at least 128×128; SVG is refused.
  `media/icon.png` is 256×256: the glyph of `media/ajmo.svg` in white on a
  rounded square, drawn in `media/icon.svg`. The colour is a first choice,
  not a decision; `galleryBanner.color` repeats it. Rebuild with macOS's own
  tool, no dependency:

      sips -s format png -z 256 256 media/icon.svg --out media/icon.png

## Windows

- A review checkout lives inside the repository folder
  (`<repo>/.git/ajmo/pr-<n>/…`), so Node's lookup of `node_modules` in parent
  folders reaches the main checkout's: package imports resolve in the review
  window without any link (the user saw it in a `korvin89` review checkout).
  A task worktree lies outside the repository and does not get this.

- There is no API to list VS Code windows. Each window writes its folders to
  `windows/<pid>.json`; the pid is its extension host, which also parents the
  window's Claude Code chat processes.
- `vscode.openFolder` with `forceNewWindow` on a folder that is already open
  focuses that window instead of opening a second one. "Open Code in New
  Window" relies on it (confirmed by the user, including a review checkout
  inside `.git`). Clicking an interactive session that runs in another
  window uses the same call; that path is unverified.
