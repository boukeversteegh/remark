package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// A caller that never saw the confirmation posts the same words again. That
// must land as a no-op naming what is already there, not as a second copy.
func TestReplyRefusesDuplicate(t *testing.T) {
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
	const doc = "# T\n\n" +
		"- [ ] Bouke (2026-09-11 09:00:00): **Root** <!--thread-->\n  the opening\n\n" +
		"  - Bouke (2026-09-11 09:05:00): a question.\n"

	newDoc := func(t *testing.T) string {
		t.Helper()
		dir := t.TempDir()
		p := filepath.Join(dir, "talk.md")
		if err := os.WriteFile(p, []byte(doc), 0o644); err != nil {
			t.Fatal(err)
		}
		return p
	}
	reply := func(t *testing.T, p string, args ...string) string {
		t.Helper()
		cmd := exec.Command(abs, append([]string{"reply", p, "2026-09-11 09:05:00",
			"-as", "CIBuild", "-text", "the same answer"}, args...)...)
		d := filepath.Dir(p)
		cmd.Env = append(os.Environ(),
			"APPDATA="+d, "LOCALAPPDATA="+d, "XDG_CONFIG_HOME="+d, "HOME="+d, "USERPROFILE="+d)
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("remark reply failed: %v\n%s", err, out)
		}
		return string(out)
	}
	count := func(p, needle string) int {
		b, err := os.ReadFile(p)
		if err != nil {
			t.Fatal(err)
		}
		return strings.Count(string(b), needle)
	}

	t.Run("the second attempt does not write", func(t *testing.T) {
		p := newDoc(t)
		first := reply(t, p)
		if !strings.Contains(first, "replied") {
			t.Fatalf("the first attempt should write: %s", first)
		}
		second := reply(t, p)
		if n := count(p, "the same answer"); n != 1 {
			t.Errorf("the document says it %d times, want once:\n%s", n, second)
		}
		if !strings.Contains(second, "already there") {
			t.Errorf("the caller was not told it is already there: %s", second)
		}
		// and it names the stamp of what IS there, so the caller can move on
		if !strings.Contains(second, "2026-09-11") {
			t.Errorf("no stamp named in: %s", second)
		}
	})

	t.Run("-again posts it anyway", func(t *testing.T) {
		p := newDoc(t)
		reply(t, p)
		reply(t, p, "-again")
		if n := count(p, "the same answer"); n != 2 {
			t.Errorf("-again should have written a second copy, got %d", n)
		}
	})

	t.Run("different words are never a duplicate", func(t *testing.T) {
		p := newDoc(t)
		reply(t, p)
		cmd := exec.Command(abs, "reply", p, "2026-09-11 09:05:00", "-as", "CIBuild", "-text", "a different answer")
		d := filepath.Dir(p)
		cmd.Env = append(os.Environ(), "APPDATA="+d, "LOCALAPPDATA="+d, "XDG_CONFIG_HOME="+d, "HOME="+d, "USERPROFILE="+d)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("%v\n%s", err, out)
		}
		if n := count(p, "answer"); n != 2 {
			t.Errorf("a genuinely different reply was swallowed, got %d", n)
		}
	})

	t.Run("another author saying the same thing is not a duplicate", func(t *testing.T) {
		p := newDoc(t)
		reply(t, p)
		cmd := exec.Command(abs, "reply", p, "2026-09-11 09:05:00", "-as", "Someone", "-text", "the same answer")
		d := filepath.Dir(p)
		cmd.Env = append(os.Environ(), "APPDATA="+d, "LOCALAPPDATA="+d, "XDG_CONFIG_HOME="+d, "HOME="+d, "USERPROFILE="+d)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("%v\n%s", err, out)
		}
		if n := count(p, "the same answer"); n != 2 {
			t.Errorf("agreement by two authors must both stand, got %d", n)
		}
	})

	// the machine-readable answer CIBuild asked for: a field, not a sentence
	t.Run("-json reports both the write and the no-op", func(t *testing.T) {
		p := newDoc(t)
		var first, second struct {
			OK        bool   `json:"ok"`
			Time      string `json:"time"`
			Duplicate bool   `json:"duplicate"`
		}
		if err := json.Unmarshal([]byte(strings.TrimSpace(reply(t, p, "-json"))), &first); err != nil {
			t.Fatalf("first -json output is not json: %v", err)
		}
		if !first.OK || first.Time == "" || first.Duplicate {
			t.Errorf("a fresh write should report ok with a stamp: %+v", first)
		}
		if err := json.Unmarshal([]byte(strings.TrimSpace(reply(t, p, "-json"))), &second); err != nil {
			t.Fatalf("second -json output is not json: %v", err)
		}
		if !second.OK || !second.Duplicate || second.Time != first.Time {
			t.Errorf("the no-op should report the existing stamp: %+v (first %+v)", second, first)
		}
	})
}

// Refusing to delete is right when someone else has replied, but the refusal
// has to say who and where, or the caller cannot judge what to do next.
func TestDeleteNamesBlockers(t *testing.T) {
	exe := "./remark"
	if runtime.GOOS == "windows" {
		exe = "./remark.exe"
	}
	if _, err := os.Stat(exe); err != nil {
		t.Skip("no built binary next to the package — run task build first")
	}
	abs, _ := filepath.Abs(exe)
	dir := t.TempDir()
	p := filepath.Join(dir, "talk.md")
	doc := "# T\n\n" +
		"- [ ] CIBuild (2026-09-11 09:00:00): **Mine** <!--thread-->\n  a duplicate I want gone\n\n" +
		"  - Bouke (2026-09-11 09:05:00): but I answered it.\n"
	if err := os.WriteFile(p, []byte(doc), 0o644); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(abs, "delete", p, "2026-09-11 09:00:00", "-as", "CIBuild")
	cmd.Env = append(os.Environ(), "APPDATA="+dir, "LOCALAPPDATA="+dir, "XDG_CONFIG_HOME="+dir, "HOME="+dir, "USERPROFILE="+dir)
	out, err := cmd.CombinedOutput()
	if err == nil {
		t.Fatal("delete should have refused while someone else's reply hangs under it")
	}
	for _, want := range []string{"Bouke", "2026-09-11 09:05:00", "line 6"} {
		if !strings.Contains(string(out), want) {
			t.Errorf("the refusal does not name %q: %s", want, out)
		}
	}
}
