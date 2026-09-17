package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWriteDeleteRemovesOnlyItsOwnSubtree(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "d.md")
	src := strings.Join([]string{
		"# Delete", "",
		"- [ ] Bob (2026-09-01 10:00:00): **Bobs** opening <!--thread-->", "",
		"  - Me (2026-09-01 10:01:00): my disposable reply.", "",
		"- [ ] Me (2026-09-01 11:00:00): **Guarded** mine, but answered <!--thread-->", "",
		"  - Bob (2026-09-01 11:01:00): an answer by someone else.", "",
	}, "\n")
	os.WriteFile(p, []byte(src), 0o644)
	if _, err := writeDelete(writeArgs{file: p, sel: "2026-09-01 10:01:00", as: "Me"}); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(p)
	s := string(got)
	t.Logf("after delete:\n%s", s)
	if strings.Contains(s, "my disposable reply") {
		t.Errorf("the target survived")
	}
	if !strings.Contains(s, "**Guarded**") {
		t.Errorf("the NEXT thread's root was taken as well")
	}
	if !strings.Contains(s, "an answer by someone else") {
		t.Errorf("a reply of the next thread went too")
	}
}
