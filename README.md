# Payload Formatter

A focused browser-only formatter for JSON and XML.

## Features

- Automatic JSON/XML detection
- Format JSON and XML in one large editor
- Copy, Paste, and Delete actions
- Best-effort formatting for escaped, nested, and irregular JSON/XML input
- Keeps a small draft in the current browser tab across refreshes
- Runs entirely in the browser; no payload is uploaded
- Static files only, so it works directly on GitHub Pages

## Run locally

Open `index.html` through any local static HTTP server. Module workers do not run reliably from `file://` URLs.

## Test

```bash
npm test
```

## Publish with GitHub Pages

This repository is intentionally build-free. Put these files on the `main` branch, then in **Settings → Pages** choose **Deploy from a branch**, select **main** and **/(root)**.

The site uses relative asset paths so it also works as a GitHub Pages project site under `/<repository-name>/`.
