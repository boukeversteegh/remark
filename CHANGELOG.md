# Changelog

Every user-facing change, one entry each. The window's "What's new" shows the
entries a running instance does not know: it asks the newer binary for its
list and subtracts its own, keyed on entry titles only. Dates are for the
eye; nothing depends on them.

## 2026-09-06

### The document scrolls under the title bar
The page area is the scroller, so its scrollbar starts below the toolbar and the caption buttons own the full width; the close button's hover fill reaches the window edge.

### Thread title on its own line
A thread's topic sits above the header row, larger and in the display font, instead of being squeezed between author, time, badges and buttons.

### What's new since you last used remark
On start, a build whose changelog has entries this machine never showed offers "What's new since last time"; the changelog as last shown is kept as a plain copy in the config dir.

### The toolbar is the title bar
The native caption is gone: one row, dragged by the toolbar, double-click to maximise, resize borders, and our own minimise, maximise and close buttons that Windows treats as the real ones (snap-layout flyout on hover, host-driven hover and press feedback).

### Notifications panel has a fixed height
The unread queue scrolls inside a capped box, so a big backlog never pushes the outline off the screen.

### Chat box keeps the sidebar's column
In chat mode the pinned message box starts where the Authors sidebar ends instead of running underneath it.

### What's new after an update
The update notice offers What's new: the entries the newer binary knows and this window does not, straight from the binaries' embedded changelogs. `remark changelog` prints a build's list.

### Chat mode for direct-message channels
A channel file renders as a linear chat: messages never fold, no resolution, a pinned message box, reply-to quotes with a link. A window opened for one instance addresses its messages to that instance.

### Message button per agent instance
Every live agent in the Authors panel has a ✉ that opens its direct-message channel, addressed to that instance only.

### Direct messages: one channel per author name
`remark dm <author> -as <name> [-to <sid>]` writes to the author's channel under the config dir; a monitor watches its own channel by itself and marks those events `dm: true`.

### Presence is per instance
Every monitor announces a session id; two monitors with one name show as two rows, and the second one gets a warning on its feed.

### Notifications panel
The sidebar lists every unread comment with author, time, thread and excerpt, sortable by latest, oldest or thread size. Authors, Notifications and Outline fold on their header.

## 2026-09-05

### Scroll position remembered per file
Restored after the first paint, once the page is tall enough to hold it.

### Outline scroll spy
The outline highlights the section and thread the document is at, in a neutral colour.

### Update notice per build
A window notices a newer binary at its path and offers Restart; dismissing covers that build only.

### Monitor working directory in the Authors tooltip
Hovering an agent shows where its monitor runs, so a worktree is obvious from the path.

### Bookmarked comments listed under their thread
One nested line per bookmarked comment in the outline; the thread stays listed whatever the filter says.

### Answer at the level you were addressed
`--help` tells agents to answer a comment under its parent or under itself, never by skipping up to the root.

## 2026-09-04

### "active 2m ago" per agent
The Authors row shows an agent's last sign of life in this file; hovering the badge counts what arrived since without its read mark.

### remark unseen
`remark unseen <files...> -as <name>` lists every comment by others that lacks the agent's read mark, including on files it was not watching.

### "no agent is watching this file"
The reply box says so when no monitor covers the file.

### Interjections
An interjected comment gets a reply seed, an insert seam survives after it for more at the same point, it indents to the parent's text column, and its direct replies render flat.

### Monitor events carry parent
Every event names the comment it answers next to the thread root; a `(now)` placeholder receiving its stamp is a `stamped` event; an agent's own hand-written comment earns a `self` nudge with the reply command that would have written it.

### remark reply and remark thread
Write verbs that place, indent, stamp and mark for the agent, so no comment is typeset by hand.

### Delete own comments
Edit mode offers Delete with an itemised confirmation; the whole subtree goes in one operation.

### "(now)" placeholder
`- Name (now): text` is a comment at once; a window or `remark stamp` fills in the real time.

### Bookmarks
A private, per-file bookmark on any comment, kept in local storage.

### Author aliases
"Also known as…" in the Authors panel folds one name into another; every same-author check follows the group. Block quotes are neutral, not blue.

### Thread-scoped monitors and @-mentions
`remark monitor -thread <sel>` and `-mine` scope an agent to its threads; `@Name` in a comment always reaches that agent; the reply box pops up an author picker on `@`.

### One delivery check per comment
Receipts collapse to one glyph per status with the agents in the tooltip.

### Keyed presence notices
An agent's went-offline, back-online and stalled notices replace one another instead of stacking.

## 2026-09-03

### Relative links open in a new remark window
A link to another markdown file spawns a window on it; other files open in their default app. Images with `../` paths render.

### remark read selectors
`16:58#2` picks the nth match, `@1310` the comment owning a file line; the ambiguous listing prints both.

### Comment references and copy button
`#r<digits>` in any text links to the comment with that timestamp; a copy button on each header puts the reference on the clipboard.

### Timestamps are identity
Every comment gets a unique seconds-precision stamp; `remark read <file> <time>` prints a comment with its subtree.

### Taskfile
`task build`, `task build:docker`, `task install`.

### Splash and window placement
A native splash until first paint; the window appears at its remembered place without a white flash.

### Landing page and recents
Thread status per recent file, removable recents, `remark recent` and `remark recent open`, several documents at once.

### Paste images
An image pasted into a comment is saved next to the document on send.

### Presence, delivery receipts and stalled detection
`-as` announces an agent in the Authors panel; a check shows when a comment reached its monitor; a blocked pipe shows as stalled.

### Agent-facing --help and remark install
The help text teaches the whole convention; `remark install` puts the binary on the PATH.

### Editing, resolution and reply slots
Edit your own comments, toggle resolution on edit, an input-shaped reply seed, amber edges for open threads, replies mark the preceding sibling read.
