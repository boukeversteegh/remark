package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// A reply continues the conversation at the level it was addressed. Nesting
// deeper is opt-in (-subthread) or forced by there being no level to
// continue: a thread root, or an interjection anchored in a paragraph.
func TestReplyPlacement(t *testing.T) {
	exe := "./remark"
	if runtime.GOOS == "windows" {
		exe = "./remark.exe"
	}
	if _, err := os.Stat(exe); err != nil {
		t.Skip("no built binary next to the package — run task build first")
	}
	abs, err := filepath.Abs(exe)
	if err != nil {
		t.Fatal(err)
	}

	// indent of the line carrying a marker string
	indentOf := func(md, needle string) int {
		for _, l := range strings.Split(md, "\n") {
			if strings.Contains(l, needle) {
				return len(l) - len(strings.TrimLeft(l, " "))
			}
		}
		return -1
	}
	run := func(t *testing.T, doc string, args ...string) string {
		t.Helper()
		dir := t.TempDir()
		p := filepath.Join(dir, "talk.md")
		if err := os.WriteFile(p, []byte(doc), 0o644); err != nil {
			t.Fatal(err)
		}
		cmd := exec.Command(abs, append([]string{"reply", p}, args...)...)
		cmd.Env = append(os.Environ(),
			"APPDATA="+dir, "LOCALAPPDATA="+dir, "XDG_CONFIG_HOME="+dir, "HOME="+dir, "USERPROFILE="+dir)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("remark reply failed: %v\n%s", err, out)
		}
		b, err := os.ReadFile(p)
		if err != nil {
			t.Fatal(err)
		}
		return string(b)
	}

	const nested = "# T\n\n" +
		"- [ ] Bouke (2026-09-10 09:00:00): **Root** <!--thread-->\n" +
		"  the opening\n\n" +
		"  - Codex (2026-09-10 09:05:00): a reply at the first level.\n\n" +
		"  - Bouke (2026-09-10 09:06:00): another at the same level.\n"

	t.Run("answering a nested comment stays at its level", func(t *testing.T) {
		md := run(t, nested, "2026-09-10 09:05:00", "-as", "Tester", "-text", "MINE")
		if got, want := indentOf(md, "MINE"), 2; got != want {
			t.Errorf("reply landed at indent %d, want %d (a sibling):\n%s", got, want, md)
		}
		// and after the last comment at that level, so stamps stay in order
		if strings.Index(md, "MINE") < strings.Index(md, "another at the same level") {
			t.Errorf("reply jumped ahead of an older sibling:\n%s", md)
		}
		// the comment that was answered is marked read by the replier
		for _, l := range strings.Split(md, "\n") {
			if strings.Contains(l, "09:05:00") && !strings.Contains(l, "Tester") {
				t.Errorf("no seen-marker on the answered comment: %s", l)
			}
		}
	})

	t.Run("-subthread nests under the target", func(t *testing.T) {
		md := run(t, nested, "2026-09-10 09:05:00", "-as", "Tester", "-text", "MINE", "-subthread")
		if got, want := indentOf(md, "MINE"), 4; got != want {
			t.Errorf("subthread reply landed at indent %d, want %d:\n%s", got, want, md)
		}
		if strings.Index(md, "MINE") > strings.Index(md, "another at the same level") {
			t.Errorf("a nested reply must stay under its target:\n%s", md)
		}
	})

	t.Run("a thread root has no level to continue", func(t *testing.T) {
		md := run(t, nested, "2026-09-10 09:00:00", "-as", "Tester", "-text", "MINE")
		if got, want := indentOf(md, "MINE"), 2; got != want {
			t.Errorf("reply to a root landed at indent %d, want %d (its child):\n%s", got, want, md)
		}
	})

	// an interjection: the parent's own text resumes below it
	const interjected = "# T\n\n" +
		"- [ ] Bouke (2026-09-10 09:00:00): **Root** <!--thread-->\n" +
		"  first paragraph\n\n" +
		"  - Codex (2026-09-10 09:05:00): a note on that paragraph.\n\n" +
		"  second paragraph, still Bouke talking\n\n" +
		"  - Bouke (2026-09-10 09:06:00): a normal reply at the end.\n"

	t.Run("an interjection only receives children", func(t *testing.T) {
		md := run(t, interjected, "2026-09-10 09:05:00", "-as", "Tester", "-text", "MINE")
		if got, want := indentOf(md, "MINE"), 4; got != want {
			t.Errorf("reply to an interjection landed at indent %d, want %d:\n%s", got, want, md)
		}
		if strings.Index(md, "MINE") > strings.Index(md, "second paragraph") {
			t.Errorf("it must sit with its interjection, not after the parent's text:\n%s", md)
		}
	})

	t.Run("a normal reply after an interjection is still a sibling", func(t *testing.T) {
		md := run(t, interjected, "2026-09-10 09:06:00", "-as", "Tester", "-text", "MINE")
		if got, want := indentOf(md, "MINE"), 2; got != want {
			t.Errorf("reply landed at indent %d, want %d:\n%s", got, want, md)
		}
	})
}
