package main

import (
	"bufio"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestMonGuidance(t *testing.T) {
	g := monGuidance(`D:\docs\talk.md`, "2026-09-10 10:26:12", "🤖 Claude")
	for _, want := range []string{"remark seen", `"D:/docs/talk.md"`, "2026-09-10 10:26:12", "🤖 Claude", "BEFORE"} {
		if !strings.Contains(g, want) {
			t.Errorf("guidance is missing %q:\n%s", want, g)
		}
	}
	// a backslash path is what a bash-ish shell eats: never emit one, and
	// never emit Go's escaped form either
	if strings.Contains(g, `\`) {
		t.Errorf("guidance carries backslashes, which shells disagree about:\n%s", g)
	}
	// an unnamed monitor cannot spell -as, but still says what to do
	if g := monGuidance("t.md", "2026-09-10 10:00:00", ""); !strings.Contains(g, "<your name>") {
		t.Errorf("no placeholder for the missing name: %s", g)
	}
}

// The instruction rides the FIRST comment a monitor delivers and never
// repeats — the whole point of the request.
func TestMonitorGuidanceOnlyOnce(t *testing.T) {
	exe := "./remark"
	if runtime.GOOS == "windows" {
		exe = "./remark.exe"
	}
	if _, err := os.Stat(exe); err != nil {
		t.Skip("no built binary next to the package — run task build first")
	}
	dir := t.TempDir()
	doc := filepath.Join(dir, "talk.md")
	seed := "# Talk\n\n- [ ] Bouke (2026-09-10 09:00:00): **Root** <!--thread-->\n  the opening\n"
	if err := os.WriteFile(doc, []byte(seed), 0o644); err != nil {
		t.Fatal(err)
	}

	cmd := exec.Command(exe, "monitor", "-as", "Tester", "-json", "-interval", "100ms", doc)
	// an isolated config: a monitor writes presence and per-name state, and
	// must never touch the developer's own
	cfg := filepath.Join(dir, "cfg")
	cmd.Env = append(os.Environ(),
		"APPDATA="+cfg, "LOCALAPPDATA="+cfg, "XDG_CONFIG_HOME="+cfg, "HOME="+dir, "USERPROFILE="+dir)
	out, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }()

	events := make(chan monEvent, 32)
	go func() {
		sc := bufio.NewScanner(out)
		sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
		for sc.Scan() {
			line := strings.TrimSpace(sc.Text())
			if !strings.HasPrefix(line, "{") {
				continue
			}
			var ev monEvent
			if json.Unmarshal([]byte(line), &ev) == nil && ev.Type == "comment" {
				events <- ev
			}
		}
	}()

	appendComment := func(stamp, text string) {
		f, err := os.OpenFile(doc, os.O_APPEND|os.O_WRONLY, 0o644)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := f.WriteString("\n  - Bouke (" + stamp + "): " + text + "\n"); err != nil {
			t.Fatal(err)
		}
		f.Close()
	}
	next := func(what string) monEvent {
		select {
		case ev := <-events:
			return ev
		case <-time.After(20 * time.Second):
			t.Fatalf("no comment event for %s", what)
			return monEvent{}
		}
	}

	time.Sleep(700 * time.Millisecond) // let the baseline settle
	appendComment("2026-09-10 10:00:00", "the first one.")
	first := next("the first comment")
	if first.Guidance == "" {
		t.Fatal("the first comment carried no guidance")
	}
	if !strings.Contains(first.Guidance, "remark seen") || !strings.Contains(first.Guidance, "2026-09-10 10:00:00") {
		t.Errorf("guidance does not name the command for this comment: %s", first.Guidance)
	}
	if !strings.Contains(first.Guidance, "Tester") {
		t.Errorf("guidance does not carry the monitor's own name: %s", first.Guidance)
	}

	appendComment("2026-09-10 10:01:00", "the second one.")
	second := next("the second comment")
	if second.Guidance != "" {
		t.Errorf("the instruction repeated on a later comment: %s", second.Guidance)
	}
}
