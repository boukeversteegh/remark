//go:build !windows

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// runInstall copies the binary to ~/.local/bin (the conventional per-user bin
// directory) and reminds about PATH when needed.
func runInstall() {
	exe, err := os.Executable()
	if err != nil {
		fmt.Fprintln(os.Stderr, "remark install:", err)
		os.Exit(1)
	}
	dir := filepath.Join(os.Getenv("HOME"), ".local", "bin")
	dest := filepath.Join(dir, "remark")
	if exe != dest {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			fmt.Fprintln(os.Stderr, "remark install:", err)
			os.Exit(1)
		}
		data, err := os.ReadFile(exe)
		if err == nil {
			err = os.WriteFile(dest, data, 0o755)
		}
		if err != nil {
			fmt.Fprintln(os.Stderr, "remark install:", err)
			os.Exit(1)
		}
		fmt.Println("installed", dest)
	} else {
		fmt.Println("already running from", dest)
	}
	for _, p := range strings.Split(os.Getenv("PATH"), ":") {
		if p == dir {
			fmt.Println("already on PATH —", dir)
			return
		}
	}
	fmt.Println("note:", dir, "is not on your PATH — add it in your shell profile:")
	fmt.Println(`  export PATH="$HOME/.local/bin:$PATH"`)
}
