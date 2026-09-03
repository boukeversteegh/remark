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
	"path/filepath"
)

var token string

const agentHelp = `remark — a discussion tool built on top of markdown.

remark renders a markdown file and lets people and agents hold threaded
discussions inside it. The whole conversation lives in the file as plain
list items, so you participate by editing the file with your normal tools.

Usage:
  remark [flags] [file.md]      open a file in its own window
  remark monitor <files...>     watch files, print each new human comment
  remark install                copy the binary to a per-user location and
                                add it to your PATH

Flags:
  -browser     open in the default browser instead of an app window
  -serve       only run the server, do not open anything
  -port N      preferred port (default 7333, falls back to next free)
  -token S     use a fixed auth token instead of a random one (testing)

The markdown convention (how to write a comment):

  Document text the discussion is about.

  - [ ] Alice (2026-09-02 14:32): **Optional title** <!--thread-->
    The rest of the comment continues on indented lines.

    - 🤖 Agent (2026-09-02 14:40): A reply — indent two spaces under
      the item you are answering. Nest deeper to reply to a reply.

Rules an agent must follow when writing:
  * Always sign with an explicit author prefix: "Name (YYYY-MM-DD HH:mm): ".
    Unsigned items are presumed to be the local human.
  * New thread roots are top-level list items attached under the paragraph
    they discuss, marked with an invisible <!--thread--> comment, and
    usually opened as "- [ ]" (an open checkbox = this needs an answer).
  * Replies are plain "- " items nested under their parent. No checkbox:
    most conversation carries no status. Only write "- [ ]" on a reply if
    it genuinely asks something that needs resolving.
  * A checkbox is its author's resolution: only the author of "- [ ]"
    decides when it becomes "- [x]". Never tick another author's box.
  * Read state: append your name to the hidden per-message marker
    <!--seen:Name1,Name2--> on the first line of a comment once you have
    processed it. Never remove other names. Do not mark your own comments.
  * A fully-bold first body line is the thread's title.
  * Do not touch document text outside the discussion items unless asked;
    ordinary checklists without <!--thread--> are content, not comments.

To wait for the human instead of polling, run:
  remark monitor doc.md -ignore-author <yourname>
It prints one line per new comment, checkbox toggle or read-marker change
by anyone else (add -json for NDJSON) and stays silent otherwise.
`

func main() {
	if len(os.Args) > 1 && os.Args[1] == "monitor" {
		runMonitor(os.Args[2:])
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "install" {
		runInstall()
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

	u := fmt.Sprintf("http://127.0.0.1:%d/?t=%s", p, token)
	title := "remark"
	if f := flag.Arg(0); f != "" {
		abs, err := filepath.Abs(f)
		if err == nil {
			u += "&f=" + url.QueryEscape(abs)
			title = filepath.Base(abs) + " — remark"
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
