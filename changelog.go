package main

// The changelog rides inside every binary. `remark changelog` prints it,
// and a running window that noticed a newer binary at its path asks THAT
// binary for its list and subtracts its own — what remains is exactly what
// this instance does not know, whatever the order things were built in.
// Entries are keyed on their "### title" alone; dates are decoration.

import (
	_ "embed"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strings"
)

//go:embed CHANGELOG.md
var changelogText string

type changeEntry struct {
	Title string `json:"title"`
	Body  string `json:"body"`
	Date  string `json:"date,omitempty"`
}

var (
	changeDateRe  = regexp.MustCompile(`^##\s+(.+?)\s*$`)
	changeTitleRe = regexp.MustCompile(`^###\s+(.+?)\s*$`)
)

// changelogEntries parses "## date" sections holding "### title" entries
// with free text below each; file order is kept (newest first by habit).
func changelogEntries(text string) []changeEntry {
	var out []changeEntry
	date := ""
	var cur *changeEntry
	for _, line := range strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n") {
		if m := changeDateRe.FindStringSubmatch(line); m != nil {
			date = m[1]
			cur = nil
			continue
		}
		if m := changeTitleRe.FindStringSubmatch(line); m != nil {
			out = append(out, changeEntry{Title: m[1], Date: date})
			cur = &out[len(out)-1]
			continue
		}
		if cur != nil && strings.TrimSpace(line) != "" {
			if cur.Body != "" {
				cur.Body += " "
			}
			cur.Body += strings.TrimSpace(line)
		}
	}
	return out
}

// whatsNew returns the entries the binary now at this process's path has
// that this process does not; ok=false when the newer binary could not be
// asked (then the caller shows everything it has).
func whatsNew() (entries []changeEntry, ok bool) {
	exe, err := os.Executable()
	if err != nil {
		return nil, false
	}
	out, err := exec.Command(exe, "changelog").Output()
	if err != nil || len(out) == 0 {
		return nil, false
	}
	known := map[string]bool{}
	for _, e := range changelogEntries(changelogText) {
		known[e.Title] = true
	}
	for _, e := range changelogEntries(string(out)) {
		if !known[e.Title] {
			entries = append(entries, e)
		}
	}
	if entries == nil {
		entries = []changeEntry{}
	}
	return entries, true
}

func runChangelog() {
	fmt.Print(changelogText)
}
