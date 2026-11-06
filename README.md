# Payload Formatter

A fast JSON and XML formatter that runs entirely in your browser. Paste a payload, even a minified, escaped or broken one, and read it as clean text or an explorable tree. Nothing is uploaded.

## Features

**Format and repair**

- Detects JSON or XML automatically
- Never changes your data: big integers, number spelling (`1.50`, `1e3`) and string escapes stay exactly as pasted, and duplicate keys are kept with a warning
- Best-effort formatting for escaped, nested and irregular input
- When a payload is still broken, an issue bar says what is wrong and where, underlines the spot, and offers a one-click fix when the fix is unambiguous

**Text view**

- Stays fast and editable on multi-megabyte payloads, because the editor (CodeMirror 6) only draws the visible lines
- Line numbers, syntax colors, undo and redo, and the cursor position in the footer (`Ln 9, Col 22 (7 selected)`)
- Search box with match count and next/previous
- Word wrap, with wrapped lines aligned under their own indentation
- Clickable minimap beside the editor

**Tree view**

- Collapsible JSON and XML tree that opens large payloads instantly, up to 10 MB
- Searches the whole payload and can step through up to 100,000 matches
- Matches what you see on screen, including `"key": "value"` lines and `attr="value"` pairs
- Copy the path of any row

**Keep your work**

- Up to 20 windows: named tabs you can rename and reorder
- Each window has its own Back/Forward history of up to 100 payloads, which survives a refresh
- History is compressed in your browser's storage, up to 500 MB in total; the oldest payloads are removed first once that is full

**Compare two payloads** (behind a flag, see [Feature flags](#feature-flags))

- Side-by-side panes that stay lined up row for row, with hatched gaps where one side has lines the other lacks
- Added, removed, changed and moved lines each get their own colour and gutter symbol, and changed lines mark the exact characters that differ
- Never changes your data. Format only adds line breaks and indentation, and every result is checked against what you pasted; if anything else would change, that side stays exactly as pasted
- Each side shows its status: As pasted, Layout only, Keys sorted, Not valid, or Not formatted. Turn Format off to see the exact pasted text
- Sort JSON keys, keeping every key and value as written, including duplicates
- Ignore menu: spaces, case, blank lines, the same value spelled differently (`1.0` and `1`, `\u00e9` and `é`), array order, and fields you name, such as timestamps and trace IDs. Ignored lines stay on screen marked `≈`, and the summary counts them
- Show menu: only the differences (click a hidden section to open it), a line detail panel showing long lines in full, and which kinds of change to highlight and step through
- Find across both sides, and `:120` to go to a line
- A path bar on each side showing where the cursor or current difference sits, with Copy path, plus the line and column under each pane
- Copy a side exactly as pasted, copy the differences, or download them as a `.diff`
- Paste, open a file, or drop one on a side, or pick any window or one of its earlier payloads. Pasting over a payload replaces it, and `Ctrl/Cmd + Z` brings it back
- Click `⇄` to jump to the other end of a moved block
- Each window has its own comparison, side names and position. A new window starts with its own payload on the left, and a side showing a window always shows that window's current text
- Comparisons and options are still there after a reload, kept only in your browser
- An overview map of every difference, and next/previous difference
- Compare any two windows, or paste or type into either side; both panes are editable and never change your windows
- Click a side's name to rename it, such as Production and UAT; names are remembered and move with their payload on swap
- Swap sides
- Runs in the background and stays quick up to 30 MB per side

**Also included**

- Path bar showing where the cursor or selected row sits, such as `$ › orders › [3] › sku`
- Inspector panel with payload stats, the current selection (Copy value, Copy as jq) and the window's history
- Epoch converter for timestamps in seconds, milliseconds, microseconds and nanoseconds
- Dark and light themes

## Keyboard shortcuts

`Ctrl` on Windows and Linux, `Cmd` on macOS.

| Shortcut | Action |
| --- | --- |
| `Ctrl/Cmd + Enter` | Format the current payload |
| `Ctrl/Cmd + F` | Focus the search box (text view) |
| `Enter` / `Shift + Enter` | Next / previous match, while in a search box |
| `F3` / `Shift + F3`, `Ctrl/Cmd + G` / `Shift + Ctrl/Cmd + G` | Next / previous match, while in the editor |
| `Esc` | Clear the search box |
| `Alt + ←` / `Alt + →` | Move the focused window tab |
| `F8` / `Shift + F8`, `Alt + ↓` / `Alt + ↑` | Next / previous difference (Compare) |
| `Ctrl/Cmd + F`, `Ctrl/Cmd + G` | Find, next match (Compare) |
| `Ctrl/Cmd + Enter` | Format and compare again (Compare) |
| `Esc` | Leave Compare, unless a menu or find bar is open or the cursor is in a pane |

## Size limits

| Payload size | What happens |
| --- | --- |
| Under 10 MB | Fully editable; tree view available |
| 10 MB to 100 MB | Read-only preview of the first 120,000 characters; Format and Copy still use the full payload; no tree view |
| Over 100 MB | Refused, and the current payload is left as it was |

History entries over 20 MB are kept for the current session only and do not survive a refresh.

## Feature flags

Flags live in [`src/feature-flags.js`](src/feature-flags.js). Change the value and deploy.

| Flag | `'Y'` | `'N'` |
| --- | --- | --- |
| `PAYLOAD_COMPARE` | Adds the Compare view next to Text and Tree | The app behaves as if Compare did not exist, and none of its code or styles are downloaded |

## Privacy

Payloads are processed and stored only in your browser. The app sends no payload data anywhere; the only outside request it makes is loading its fonts from Google Fonts.

## Run locally

Open `index.html` through any local static HTTP server. Module workers do not run reliably from `file://` URLs.

## Project structure

```text
index.html        The page (stays at the root so the site serves from it)
assets/           Icons
src/
  app.js          Main wiring
  ui-controls.js  Small page controls
  editor/         Text editor, its search box, minimap, issue bar
  tree/           Tree view
  format/         Detection, formatting, repair (runs in a worker)
  history/        Windows and paste history, including browser storage
  panels/         Inspector and epoch converter
  compare/        Compare view and its diff engine (loaded only when flagged on)
  feature-flags.js  On/off switches for features
  styles/         CSS
tests/            Test suite (run with npm test)
scripts/          Production build and benchmark
vendor/           Pre-bundled CodeMirror
```

## Editor bundle

The text editor is CodeMirror 6, pre-bundled into `vendor/codemirror/codemirror.js` so the site needs no build step. After changing `vendor/codemirror/entry.js` or the pinned versions in `package.json`, rebuild it:

```bash
npm run vendor:codemirror
```

## Test

```bash
npm install
npm test
```

The tests run in Node with jsdom, which has no layout engine, so check visual and performance changes in a real browser too. `npm run benchmark` measures formatting speed.

## Deploy

The site is static, so it needs no server and no build step to run. Pushing to `main` runs `.github/workflows/deploy-pages.yml`, which runs the tests, builds `dist/` with `npm run build` (cache-busted asset URLs) and publishes it to GitHub Pages. In the repository, set **Settings → Pages → Source** to **GitHub Actions**.

The site uses relative asset paths, so it also works as a project site under `/<repository-name>/`.
