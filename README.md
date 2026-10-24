# JSON/XML Formatter

A focused browser-only formatter for JSON and XML.

## Features

- Automatic JSON/XML detection
- Dark and light themes with a saved browser preference
- Format JSON and XML in one large editor
- Word-wrap toggle for long lines
- Fast editor for multi-megabyte payloads (CodeMirror 6): line numbers, syntax colors, undo, and a search box with match count (Ctrl/Cmd+F)
- Copy, Paste, and Delete actions
- Payload history: roll back/forward through previously pasted payloads
- Payload windows: named tabs for juggling multiple payloads (double-click to rename)
- Best-effort formatting for escaped, nested, and irregular JSON/XML input
- Keeps a small draft in the current browser tab across refreshes
- Runs entirely in the browser; no payload is uploaded
- Static files only, so it works directly on GitHub Pages

## Run locally

Open `index.html` through any local static HTTP server. Module workers do not run reliably from `file://` URLs.

## Editor bundle

The text editor is CodeMirror 6, pre-bundled into `vendor/codemirror/codemirror.js` so the site needs no build step. After changing `vendor/codemirror/entry.js` or the pinned versions in `package.json`, rebuild it:

```bash
npm run vendor:codemirror
```

## Test

```bash
npm test
```

## Publish with GitHub Pages

This repository is intentionally build-free. Put these files on the `main` branch, then in **Settings → Pages** choose **Deploy from a branch**, select **main** and **/(root)**.

The site uses relative asset paths so it also works as a GitHub Pages project site under `/<repository-name>/`.
