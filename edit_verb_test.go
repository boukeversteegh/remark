package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWriteEditKeepsTitleAndMarkers(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "t.md")
	src := "# T\n\n- [ ] Me (2026-09-01 10:00:00): **Mine** the original text <!--thread--> <!--seen:Bob-->\n\n  - Bob (2026-09-01 10:01:00): a reply\n"
	if err := os.WriteFile(p, []byte(src), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := writeEdit(writeArgs{file: p, sel: "10:00:00", as: "Me", text: "**Mine** the corrected text"}, nil); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(p)
	s := string(got)
	t.Logf("after edit:\n%s", s)
	for _, want := range []string{"the corrected text", "<!--thread-->", "<!--seen:Bob-->", "Bob (2026-09-01 10:01:00): a reply", "- [ ] Me (2026-09-01 10:00:00):"} {
		if !strings.Contains(s, want) {
			t.Errorf("missing %q", want)
		}
	}
	if strings.Contains(s, "the original text") {
		t.Errorf("old body survived")
	}
}
