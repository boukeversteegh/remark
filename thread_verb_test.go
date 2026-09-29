package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWriteThreadAnchors(t *testing.T) {
	src := strings.Join([]string{
		"# Doc", "",
		"## Board", "",
		"- [ ] Bob (2026-09-01 10:00:00): **First** opening <!--thread-->", "",
		"  - Bob (2026-09-01 10:01:00): a reply.", "",
		"## Later", "",
		"closing prose.", "",
	}, "\n")
	write := func(t *testing.T) string {
		dir := t.TempDir()
		p := filepath.Join(dir, "t.md")
		if err := os.WriteFile(p, []byte(src), 0o644); err != nil {
			t.Fatal(err)
		}
		return p
	}

	// after a comment: the new thread follows that thread's whole block
	p := write(t)
	if _, err := writeThread(writeArgs{file: p, as: "Me", text: "anchored after the first thread", after: "2026-09-01 10:00:00"}); err != nil {
		t.Fatal(err)
	}
	got := strings.Split(readFileString(t, p), "\n")
	iNew, iReply, iLater := lineOf(got, "anchored after the first thread"), lineOf(got, "a reply."), lineOf(got, "## Later")
	if !(iReply < iNew && iNew < iLater) {
		t.Errorf("after-anchor landed wrong: reply %d, new %d, ## Later %d", iReply, iNew, iLater)
	}

	// at a section's end
	p = write(t)
	if _, err := writeThread(writeArgs{file: p, as: "Me", text: "at the end of Later", section: "Later"}); err != nil {
		t.Fatal(err)
	}
	got = strings.Split(readFileString(t, p), "\n")
	if lineOf(got, "at the end of Later") < lineOf(got, "## Later") {
		t.Errorf("section anchor put the thread above its heading")
	}

	// a stamp that matches nothing is an error, not a write
	p = write(t)
	if _, err := writeThread(writeArgs{file: p, as: "Me", text: "nowhere", after: "1999-01-01 00:00:00"}); err == nil {
		t.Errorf("an unknown anchor was accepted")
	}
}

func readFileString(t *testing.T, p string) string {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func lineOf(lines []string, needle string) int {
	for i, l := range lines {
		if strings.Contains(l, needle) {
			return i
		}
	}
	return -1
}
