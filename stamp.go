package main

// remark stamp <file...>: replace every "(now)" placeholder in an author
// prefix with the real time. A writer that does not want to invent a
// timestamp (an agent, a hand edit) writes "- Name (now): text"; the line is
// a comment right away and gets its identity here — or from a remark
// window on the file, which stamps placeholders the same way once the file
// settles. Stamps are unique per file: a second already taken bumps forward.

import (
	"fmt"
	"os"
	"regexp"
	"strings"
	"time"
)

var (
	stampNowRe   = regexp.MustCompile(`^(\s*- (?:\[[ xX]\] )?)(.{1,48}?) \(now\):(\s.*|)$`)
	stampTakenRe = regexp.MustCompile(`\((\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\)`)
)

// stampPlaceholders rewrites the "(now)" prefixes in content, returning the
// new content and how many were stamped.
func stampPlaceholders(content string, now time.Time) (string, int) {
	taken := map[string]bool{}
	for _, m := range stampTakenRe.FindAllStringSubmatch(content, -1) {
		taken[m[1]] = true
	}
	eol := "\n"
	if strings.Contains(content, "\r\n") {
		eol = "\r\n"
	}
	lines := strings.Split(strings.ReplaceAll(content, "\r\n", "\n"), "\n")
	n := 0
	inFence := false
	for i, line := range lines {
		if monFenceRe.MatchString(line) {
			inFence = !inFence
			continue
		}
		if inFence {
			continue
		}
		m := stampNowRe.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		t := now
		for taken[t.Format("2006-01-02 15:04:05")] {
			t = t.Add(time.Second)
		}
		ts := t.Format("2006-01-02 15:04:05")
		taken[ts] = true
		lines[i] = m[1] + m[2] + " (" + ts + "):" + m[3]
		n++
	}
	return strings.Join(lines, eol), n
}

func runStamp(args []string) {
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, "usage: remark stamp <file...>")
		os.Exit(2)
	}
	for _, f := range args {
		b, err := os.ReadFile(f)
		if err != nil {
			fmt.Fprintln(os.Stderr, "remark stamp:", err)
			os.Exit(1)
		}
		out, n := stampPlaceholders(string(b), time.Now())
		if n > 0 {
			if err := os.WriteFile(f, []byte(out), 0o644); err != nil {
				fmt.Fprintln(os.Stderr, "remark stamp:", err)
				os.Exit(1)
			}
		}
		fmt.Printf("%s: stamped %d comment(s)\n", f, n)
	}
}
