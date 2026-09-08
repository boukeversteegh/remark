package main

// The help an agent actually reads: harnesses tend to clip output around
// 60 lines, so everything that matters lives in the first screen of
// `remark help`, and the depth moved to topics (`remark help format`,
// `remark help monitor`, `remark help sharing`).

import (
	"fmt"
	"os"
)

const agentHelp = `remark — a discussion tool built on top of markdown.

remark renders a markdown file and lets people and agents hold threaded
discussions inside it; the conversation lives in the file as list items.
WRITE THROUGH THE VERBS below — they place, indent, stamp and mark read
for you. Hand-editing the file is how formatting faults happen; keep it
for the rare thing no verb covers, and re-read the file right before.

Reading and watching:
  remark [flags] [files.md]      open each document in its own window
  remark read <file>             thread index: stamp, author, title, replies
  remark read <file> <sel>       one comment plus subtree; selectors:
                                 "14:05:31", "16:58#2" (nth), "@1310" (line)
  remark monitor <files> -as <name>   stream new comments — a LONG-RUNNING
                                 watcher, never a blocking call; details
                                 and -json events: remark help monitor
  remark unseen <files> -as <name>    everything you have not read yet
  remark recent [open]           recent files; "open" opens windows

Writing — the verbs:
  remark reply <file> <sel> -as <name> [-text t | -file p | stdin]
                                 answer a comment: placed after its
                                 subtree, stamped, seen-marked for you
  remark thread <file> -as <name> [-title t] [-plain]
                 (-after <sel> | -section <h> | -end) [-text|-file|stdin]
                                 open a new thread root
  remark edit <file> <sel> -title <t>    set the thread's title
  remark tag <file> <sel> #a #b -as <name>   tag someone's comment
  remark dm <author> -as <name> [-to <sid>] [-text|-file|stdin]
                                 direct message on <author>'s channel
  remark stamp <file>            fill "(now)" placeholders with real times

Sharing and the rest:
  remark gateway [status|stop|add|remove|qr|rotate]   phone and group
                                 access (groups: remark help sharing)
  remark changelog               what this build changed
  remark install                 put remark on your PATH
  remark help [topic]            topics: format, monitor, sharing

The five rules that matter (the long form: remark help format):
  1. Sign every comment "Name (now): " — remark replaces (now) with the
     real, unique stamp by itself. That timestamp IS the comment's
     identity; write one by hand only when no remark is running, and
     never reuse one. Names match byte for byte, everywhere.
  2. A nested "- " line is a comment ONLY with an authored timestamp (or
     "(now)"); plain bullets and bare "- [ ]" boxes in a body stay body.
  3. "- [ ]" is the thread's open/closed RESOLUTION, settled by its
     author — not "needs an answer" (answering is expected anyway);
     never tick another author's box.
  4. Read state: append your name to the <!--seen:...--> marker on a
     comment's first line once processed; never remove other names.
  5. Threads stay FLAT: answer at the level you were addressed.
`

const helpFormat = `The markdown format — a complete exchange:

  Some paragraph of the document under discussion.

  - [ ] Alice (2026-09-03 14:02): **Batch size** <!--thread--> <!--seen:agent-->
    Why 512? Feels arbitrary — did we measure this?

    - 🤖 Agent (2026-09-03 14:05): Measured, thinly: 256 and 1024 were
      within 3% on the sample corpus. I can add the benchmark to the PR.

      - Alice (2026-09-03 14:09): good, add it <!--seen:agent-->

The rules, in full — for when you must hand-edit after all:
  * Prefer the write verbs (reply, thread, edit, tag): every structural
    fault seen so far came from a hand-typed edit.
  * Sign every comment: "Name (now): ..." — a remark window or "remark
    stamp" replaces (now) with the real stamp, unique per file, bumping
    past collisions by itself. Identity is the LITERAL string — no case
    folding, no emoji stripping; your author prefix, -as flag and
    seen-marker entries must be identical. Unsigned TOP-LEVEL items are
    presumed to be the local human.
  * The filled-in timestamp is the comment's IDENTITY: remark read and
    the #r references address comments by it, so never edit or reuse
    one. Write a literal timestamp yourself only when the edit happens
    with no remark running to stamp it — then seconds precision, and
    bump a second if yours is taken.
  * A nested "- " line becomes a comment through its authored timestamp
    (or "(now)") — nothing else. Ordinary bullets, "Word: text" lines
    and bare "- [ ]" task boxes inside a body stay body content.
  * New thread roots are top-level items under the paragraph they
    discuss, marked <!--thread-->, usually opened "- [ ]": the box is
    the thread's open/closed resolution, not "an answer is needed" —
    answering is expected regardless.
  * Replies are plain "- " items nested under their parent — no checkbox
    unless the reply genuinely needs its own resolution.
  * Keep threads FLAT, at the level you were addressed: answer a comment
    under its parent (as a sibling) or under the comment itself — never
    skip levels up to the root from inside a side thread.
  * A checkbox is its author's resolution: only the author of "- [ ]"
    ticks it. Never resolve another author's box.
  * Read state: a hidden <!--seen:Name1,Name2--> marker at the END of a
    comment's FIRST line (after <!--thread-->). Create it if missing,
    append your name once processed, never remove other names. Your own
    comments carry no marker from you.
  * The thread title is the first body line when it is ENTIRELY bold —
    inline after the colon or alone on the first continuation line, but
    nothing after the closing **. remark edit -title writes it right.
  * Tags: "#word" in a comment, preceded by whitespace (letter first;
    not in code, URLs or link anchors; not "#123", not hex colors, not
    "#r..." references). A reply
    whose whole body is tags is a READER TAG on its parent, not a
    comment — that is what remark tag writes.
  * Concurrent edits are normal: the human's window writes this file
    too. Re-read right before each hand edit, replace only your lines,
    never rewrite the file from a stale copy.
  * Do not touch document text outside the discussion items unless
    asked; checklists without <!--thread--> are content, not comments.
`

const helpMonitor = `remark monitor <files...> -as <yourname> [-json]

This is a STREAM, not a command that finishes: one line per new comment,
checkbox toggle, read-marker or tag change by anyone else, until stopped.
Globs are accepted; a path that does not exist is refused at startup.

Agents: attach it as a background/monitor task that hands you stdout
lines as they arrive. Do NOT call it as a blocking shell command — that
parks your turn and events only reach you when the call dies. A monitor
that prints "watching N file(s)" and then nothing is that mistake.

Each plain event line is:
  <mark> <file> | <section> › <thread> | <author>: <text>
with <mark>: 💬 comment, ☑/☐ toggle, 👁 read marker, 🏷 tags changed.

-json emits one NDJSON object per event: type ("comment"|"toggle"|
"seen"|"stamped"|"tag"|"self"), file, author, text, time, checked,
reader, seenBy, section, thread, root, parent, tags.
  * "root" is the thread root's stamp: remark read <file> <root> prints
    the whole thread; "parent" is the comment this one answers. Reply to
    root to answer flat, to time for a side thread.
  * "seen" events: the ACTOR is "reader" (the name just added); the
    -as filter judges the reader, so your own read-marks never wake you.
  * "stamped": a "(now)" placeholder received its real time.
  * "self": your own hand-written comment was noticed — it carries a
    "hint" with the remark reply command that would have written it.

Scoping (many agents, one file):
  -thread <selector|title>   only threads whose root matches (repeatable)
  -mine                      only threads you took part in or are @named in
A comment that tags "@<yourname>" ALWAYS reaches you. A scoped agent
writes seen-markers only on comments it was woken for.

-as also announces presence: windows show you online in "Who's here"
while the monitor runs. -ignore-author takes a comma-separated list;
the agent's own DM channel is always watched too.
`

const helpSharing = `Sharing: the gateway and groups.

The gateway is one long-running process ("remark gateway", usually
started from a window's Phone panel) that serves the same UI over your
network or VPN, guarded by a pairing code. Your own phone gets the
documents you put on it (add/remove/qr/rotate, or the panel's Myself
switch).

Groups share documents with OTHER people: each group holds its own set
of documents behind its own key and QR (a /g/<id>?k=<key> join link).
Members scan the code, pick the name they will write under — stored
only on their device, none of the owner's prefs reach them — and see
only that group's documents. Within a group everyone sees everyone in
the Authors panel; the owner's prefs, gateway controls, foreign paths
and DMs to desktop agents are all refused to members. Image paste is
allowed, scoped to the group's documents.

Managed from the window: the Phone panel's share switches (Myself and
one per group, any of them starting the gateway), and its Groups fold
for members, invites, new codes and deletion. Revoking one group's code
never touches another group or your own pairing.
`

func runHelp(args []string) {
	topic := ""
	if len(args) > 0 {
		topic = args[0]
	}
	switch topic {
	case "":
		fmt.Print(agentHelp)
	case "format", "convention":
		fmt.Print(helpFormat)
	case "monitor":
		fmt.Print(helpMonitor)
	case "sharing":
		fmt.Print(helpSharing)
	default:
		fmt.Fprintf(os.Stderr, "remark help: unknown topic %q — topics: format, monitor, sharing\n", topic)
		os.Exit(2)
	}
}
