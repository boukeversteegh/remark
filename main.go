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

func main() {
	port := flag.Int("port", 7333, "preferred port (falls back to next free)")
	browser := flag.Bool("browser", false, "open in the default browser instead of an app window")
	noOpen := flag.Bool("serve", false, "only run the server, do not open anything")
	fixedToken := flag.String("token", "", "use a fixed auth token instead of a random one (testing)")
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
