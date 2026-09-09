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


// winKey is the prefs key this window's placement lives under: per document
// once one is open, the shared legacy "win" otherwise (and as fallback).
var winKey = "win"

func main() {
	attachConsole()
	go sweepOldBinaries()
	if len(os.Args) > 1 && os.Args[1] == "help" {
		runHelp(os.Args[2:])
		return
	}
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
	if len(os.Args) > 1 && os.Args[1] == "seen" {
		runSeen(os.Args[2:])
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "delete" {
		runDelete(os.Args[2:])
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "edit" {
		runEdit(os.Args[2:])
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "reply" {
		runReply(os.Args[2:])
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "thread" {
		runThread(os.Args[2:])
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "unseen" {
		runUnseen(os.Args[2:])
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "tag" {
		runTag(os.Args[2:])
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "tags" {
		runTags(os.Args[2:])
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "dm" {
		runDm(os.Args[2:])
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "changelog" {
		runChangelog()
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "gateway" {
		runGateway(os.Args[2:])
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
	dmTo := flag.String("to", "", "DM channels: address messages written in this window to one running instance (its session id)")
	flag.Usage = func() { fmt.Fprint(os.Stderr, agentHelp) }
	flag.Parse()

	// a positional that is not a .md file is almost always a mistyped
	// subcommand — fail instead of opening a window on a nonexistent file
	for _, a := range flag.Args() {
		if !strings.HasSuffix(strings.ToLower(a), ".md") {
			fmt.Fprintf(os.Stderr, "remark: %q is not a command or a .md file — see remark help\n", a)
			os.Exit(1)
		}
	}

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
	if *dmTo != "" {
		u += "&to=" + *dmTo // the page stamps its messages with <!--to:sid-->
	}
	title := "remark"
	first := ""
	if len(docs) > 0 {
		first = docs[0]
	}
	if f := first; f != "" {
		abs, err := filepath.Abs(f)
		if err == nil {
			// each document remembers its own window bounds — two documents
			// on two monitors must not fight over one placement
			winKey = "win:" + presenceNormPath(abs)
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
