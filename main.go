package main

import (
	"crypto/rand"
	"encoding/hex"
	"flag"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

var token string

const agentHelp = `remark — a discussion tool built on top of markdown.

remark renders a markdown file and lets people and agents hold threaded
discussions inside it. The whole conversation lives in the file as plain
list items, so you participate by editing the file with your normal tools.

Usage:
  remark [flags] [files...]     open each document in its own window
                                (globs accepted)
  remark monitor <files...>     watch files, print each new human comment
  remark recent                 list recent files, one path per line —
                                feed it to monitor to watch them all
  remark recent open            open a window for every recent file
  remark read <file>            index of every thread: timestamp, author,
                                title, reply count — orient before editing
  remark read <file> <time...>  print the comment matching a timestamp plus
                                its whole subtree, ancestors as one-line
                                breadcrumbs and file line numbers included.
                                Selectors match at component boundaries:
                                "14:05:31", "14:05", "2026-09-03 14:05" all
                                work; ambiguous selectors list their matches
                                with two exact forms to copy: "16:58#2" (the
                                nth match, document order) and "@1310" (the
                                comment owning file line 1310).
                                -depth N limits the subtree (0 = node alone),
                                -parents prints full ancestor bodies
  remark stamp <file...>        replace every "(now)" placeholder in an
                                author prefix with the real, unique time —
                                what a remark window on the file also does
                                by itself once the file settles
  remark install                copy the binary to a per-user location and
                                add it to your PATH

Flags:
  -browser     open in the default browser instead of an app window
  -serve       only run the server, do not open anything
  -port N      preferred port (default 7333, falls back to next free)
  -token S     use a fixed auth token instead of a random one (testing)

The markdown convention — a complete exchange looks like this:

  Some paragraph of the document under discussion.

  - [ ] Bouke (2026-09-03 14:02): **Batch size** <!--thread--> <!--seen:agent-->
    Why 512? Feels arbitrary — did we measure this?

    - 🤖 Agent (2026-09-03 14:05): Measured, thinly: 256 and 1024 were
      within 3% on the sample corpus. I can add the benchmark to the PR.

      - Bouke (2026-09-03 14:09): good, add it <!--seen:agent-->

Rules an agent must follow when writing:
  * Sign every comment: "Name (YYYY-MM-DD HH:mm:ss): ". Unsigned items are
    presumed to be the local human. Identity is the LITERAL string: names
    match byte for byte (no case folding, no emoji stripping), so pick ONE
    exact name and use it everywhere — your author prefix, your -as flag
    and your seen-marker entries must be identical. The timestamp is what marks a nested
    "- " line as a comment — ordinary list bullets inside a comment body
    (even "Word: text" ones) are left alone, so bodies may contain lists.
  * Timestamps are comment IDENTITY: write seconds precision, and never
    give two comments in one file the same timestamp — if the second you
    are writing in is taken, bump forward one second. remark read
    addresses comments by these timestamps.
  * Don't know the time, or don't want to get it wrong? Write "(now)" in
    the timestamp slot — "- Name (now): text". That line is a comment at
    once (unlike a bare "- Name: text", which stays body content), and a
    remark window on the file, or "remark stamp <file>", replaces "(now)"
    with the real unique stamp. Never invent a stamp.
  * New thread roots are top-level list items attached under the paragraph
    they discuss, marked with an invisible <!--thread--> comment, and
    usually opened as "- [ ]" (an open checkbox = this needs an answer).
  * Replies are plain "- " items nested under their parent. No checkbox:
    most conversation carries no status. Only write "- [ ]" on a reply if
    it genuinely asks something that needs resolving.
  * A checkbox is its author's resolution: only the author of "- [ ]"
    decides when it becomes "- [x]". Never tick another author's box.
  * Read state: a hidden <!--seen:Name1,Name2--> marker at the END of a
    comment's FIRST line (after <!--thread--> when present) — see the
    example above. Create it yourself if it is missing, append your name
    to it once you have processed the comment, never remove other names.
    Do not mark your own comments.
  * The thread title is the first body line when it is entirely bold.
    Inline after the colon (as in the example) and alone on the first
    continuation line are the SAME rule — the inline form is what remark
    itself writes.
  * Concurrent edits are normal: the human's window writes to this file
    too. Re-read the file right before each edit and make targeted
    replacements — never rewrite the whole file from a stale copy, or you
    will overwrite a comment they just sent.
  * Do not touch document text outside the discussion items unless asked;
    ordinary checklists without <!--thread--> are content, not comments.

Opening a window:
  remark file.md prints the URL and returns immediately — that is
  fire-and-forget, not a crash: the window and its server keep running
  detached. Opening the same file again is safe (you get a second window).

Waiting for replies:
  remark monitor doc.md -as <yourname>

  This is a STREAM, not a command that finishes. It prints one line per new
  comment, checkbox toggle or read-marker change by anyone else, and keeps
  running until you stop it.

  Agents: attach it the way your harness attaches a long-running watcher —
  a background/monitor task that hands you each stdout line as it arrives.
  Do NOT call it as an ordinary blocking shell command: that parks your turn
  and the comments only reach you when the call is killed. A monitor that
  returns immediately with just "watching N file(s)" and nothing after it is
  the symptom of exactly that mistake.

  Each event line is:
    <mark> <file> | <section> › <thread> | <author>: <text>
  with <mark> being 💬 comment, ☑/☐ resolution toggle, 👁 read marker.

  -json emits one NDJSON object per event instead, with fields:
    type ("comment"|"toggle"|"seen"), file, author, text, time, checked,
    reader, seenBy, section, thread, root  (omitted when empty).
  "root" is the thread root's timestamp: remark read <file> <root> prints
  the whole thread the event belongs to.
  For seen-events the ACTOR is "reader" — the name just added to the
  marker; "author" stays the comment's author. The -as/-ignore-author
  filter judges the reader on seen-events, so you are never woken by
  your own read-markers and always learn when someone reads yours.

  Scoping to threads (many agents on one file, e.g. an orchestrator's
  TODO.md where each worker owns a thread):
    -thread <selector>   only threads whose root matches — a timestamp
                         selector as for remark read, or the title verbatim;
                         repeatable or comma-separated
    -mine                only threads you took part in: a comment signed
                         with your -as name, or one that tags you (@name)
  Both combine. A comment that tags you ("@<yourname>", the literal name,
  ending where the name ends) ALWAYS reaches you, whatever the scope, and
  being tagged in a thread enrolls you in it under -mine. A scoped agent
  writes seen-markers only on comments it was woken for, so the other
  threads stay free of its receipts.

  -as also announces your presence: remark windows on a file in your scope
  show you as online in the "Who's here" panel while the monitor runs, so
  the human knows their messages are being heard. To ignore additional
  authors (say, a second agent on the same file), -ignore-author takes a
  comma-separated list and combines with -as; giving a flag twice does NOT
  accumulate — the last value wins.
`

func main() {
	attachConsole()
	go sweepOldBinaries()
	if len(os.Args) > 1 && os.Args[1] == "monitor" {
		runMonitor(os.Args[2:])
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "install" {
		runInstall()
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "read" {
		runRead(os.Args[2:])
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "stamp" {
		runStamp(os.Args[2:])
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "recent" {
		// one path per line, so an agent can do:
		//   remark monitor $(remark recent) -as <name>
		// "remark recent open" opens a window per recent file instead.
		var rec []string
		prefsGetKey("recents", &rec)
		if len(os.Args) > 2 && os.Args[2] == "open" {
			exe, err := os.Executable()
			if err != nil {
				fmt.Fprintln(os.Stderr, "remark recent open:", err)
				os.Exit(1)
			}
			n := 0
			for _, p := range rec {
				if _, err := os.Stat(p); err == nil {
					if exec.Command(exe, p).Start() == nil {
						n++
					}
				}
			}
			fmt.Printf("remark: opening %d recent file(s)\n", n)
			return
		}
		for _, p := range rec {
			if _, err := os.Stat(p); err == nil {
				fmt.Println(p)
			}
		}
		return
	}
	port := flag.Int("port", 7333, "preferred port (falls back to next free)")
	browser := flag.Bool("browser", false, "open in the default browser instead of an app window")
	noOpen := flag.Bool("serve", false, "only run the server, do not open anything")
	fixedToken := flag.String("token", "", "use a fixed auth token instead of a random one (testing)")
	flag.Usage = func() { fmt.Fprint(os.Stderr, agentHelp) }
	flag.Parse()

	if *fixedToken != "" {
		token = *fixedToken
	} else {
		b := make([]byte, 16)
		rand.Read(b)
		token = hex.EncodeToString(b)
	}

	var ln net.Listener
	var err error
	p := *port
	for i := 0; i < 20; i++ {
		ln, err = net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", p))
		if err == nil {
			break
		}
		p++
	}
	if ln == nil {
		fmt.Fprintln(os.Stderr, "remark: could not bind a port:", err)
		os.Exit(1)
	}

	// multiple documents (or globs), like monitor takes them: this process
	// keeps the first, every further document gets its own spawned window
	var docs []string
	for _, a := range flag.Args() {
		if m, _ := filepath.Glob(a); m != nil {
			docs = append(docs, m...)
		} else {
			docs = append(docs, a)
		}
	}
	if len(docs) > 1 {
		if exe, err := os.Executable(); err == nil {
			for _, f := range docs[1:] {
				exec.Command(exe, f).Start()
			}
		}
	}

	u := fmt.Sprintf("http://127.0.0.1:%d/?t=%s", p, token)
	title := "remark"
	first := ""
	if len(docs) > 0 {
		first = docs[0]
	}
	if f := first; f != "" {
		abs, err := filepath.Abs(f)
		if err == nil {
			u += "&f=" + url.QueryEscape(abs)
			title = filepath.Base(abs) + " — remark"
			// the document's own title beats its filename
			if b, err := os.ReadFile(abs); err == nil {
				for _, ln := range strings.Split(strings.ReplaceAll(string(b), "\r\n", "\n"), "\n") {
					if strings.HasPrefix(ln, "# ") {
						if h := strings.TrimSpace(ln[2:]); h != "" {
							title = h + " — remark"
						}
						break
					}
				}
			}
		}
	}

	go func() {
		if err := http.Serve(ln, newMux()); err != nil {
			fmt.Fprintln(os.Stderr, "remark: server stopped:", err)
			os.Exit(1)
		}
	}()

	fmt.Println("remark listening on", u)

	switch {
	case *noOpen:
		select {}
	case *browser:
		openBrowser(u)
		select {}
	default:
		if !runWindow(u, title) {
			openBrowser(u)
			select {}
		}
	}
}
