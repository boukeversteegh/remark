# remark ✏️

**A discussion tool built on top of markdown.** remark renders a markdown
document and lets people — and AI agents — hold threaded discussions inside
it: comments, replies and read-markers are plain checkbox list items stored in
the file itself, so the document and the conversation about it live in one
portable, diffable `.md` file. Use it to review an agent's work, co-edit a
living document, or keep a structured conversation anchored to the text it is
about.

The other side (an agent, a teammate, a script) can keep writing to the file
while you have unsent drafts open: remark keeps comment state in memory,
watches the file in realtime, and saves via compare-and-swap with automatic
retry, so nobody's edits are ever lost. No git involved — the file can be an
uncommitted scratch file inside a repo.

## The markdown convention

Threads are plain checkbox list items, so the file stays readable everywhere:

```markdown
Some paragraph of the document being discussed.

- [ ] Alice (2026-09-02 14:32): I don't agree with this part. <!--rv-->

  - [x] 🤖 Agent (2026-09-02 14:40): Fair — here's why I wrote it that way…
```

- A **top-level** `- [ ] Author: text` item is a thread root; **indented**
  checkbox items under it are replies (arbitrary nesting supported).
- The author prefix may carry a plain-text timestamp — `Author (YYYY-MM-DD
  HH:mm):` — which remark writes on every comment it creates and renders as a
  dim time next to the author. Comments without one are fine too.
- The checkbox is a **read-marker** (a notification, essentially): you tick
  the other side's comments when you've read them; they tick yours when
  they've processed them. Unticked comments from others show as **unread**.
- Comments written by remark carry an invisible `<!--rv-->` marker so inline
  threads are unambiguously distinguishable from ordinary task lists (an
  agent's task log at the top of the file is rendered as plain markdown and
  left alone). For unmarked files a heuristic also recognises
  `- [ ] Name: …` / `- [ ] 🤖 Name: …` items as threads.

## Usage

```
remark.exe path\to\review.md          # opens in its own window (WebView2)
remark.exe -browser file.md           # use the default browser instead
remark.exe -serve -port 7333 file.md  # headless server only
```

Run it with no argument to get a landing page with a native file picker and
recent files. Try it on the bundled sample: `remark.exe examples\demo.md`. Run it again
with another file to get a second window — one window per file, each instance
picks the next free port. Author name, view mode, recents and unsent drafts
are shared across all windows (stored in `%APPDATA%\remark\prefs.json` /
`~/.config/remark/prefs.json`).

The UI follows the system light/dark theme automatically and uses the system
UI font (Segoe UI Variable on Windows).

- **Inline / Margin** — comments in the document flow (collapsible per
  thread, ⊟/⊞ collapse all), or Word-style review cards in a right margin
  aligned to the paragraph they belong to.
- **💬 on hover** over any paragraph starts a new thread there; **↩ reply**
  on any comment nests a reply. Markdown allowed; Ctrl+Enter sends.
- **"as \[name\]"** in the toolbar sets the author your comments are signed with.
- The unread pill jumps through unread comments; new agent comments flash in
  live as the file changes on disk.

## How conflicts are handled

Your unsent drafts live in memory (and localStorage) — external file changes
just re-render the document under them. Sending a comment creates an
*operation* anchored by content (which paragraph / which parent comment), not
by line number. Saving is a compare-and-swap: if the file changed underneath,
remark re-reads it, re-applies your operations to the fresh content and
retries. If the anchor itself was deleted from the file, the comment is never
dropped — it lands in a tray where you can copy it, append it at the end, or
discard it.

## Building

Pure Go, no C toolchain needed:

```
go build -ldflags "-H windowsgui -s -w" -o remark.exe .          # Windows
GOOS=linux  go build -s -o remark-linux .                        # Linux
GOOS=darwin GOARCH=arm64 go build -o remark-macos .              # macOS
```

`rsrc_windows_amd64.syso` embeds the app icon (`assets/icon.ico`) and the
manifest (`assets/app.manifest`, which declares Per-Monitor-V2 DPI awareness —
without it the window renders blurry on scaled displays). It is picked up by
`go build` automatically; regenerate it after changing either asset with:

```
go install github.com/akavel/rsrc@latest
rsrc -manifest assets/app.manifest -ico assets/icon.ico -o rsrc_windows_amd64.syso
```

On Windows the window is a native WebView2 (ships with Windows 11). On
macOS/Linux the same binary opens a chromium `--app=` window when a
chromium-family browser is installed, and falls back to the default browser
otherwise.

License: [MIT](LICENSE).

Layout: `main.go` / `server.go` (CAS file API + SSE watcher), `ui/` (embedded
frontend; `ui/parser.js` holds the thread parser + operation applier and is
directly testable in Node). Icons: [Lucide](https://lucide.dev) (ISC), embedded
in `ui/icons.js`. Note the UI is embedded via `go:embed` — rebuild after
editing anything under `ui/`.
