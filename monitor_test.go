package main

import (
	"bufio"
	"encoding/json"
	"fmt"
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

func TestMonBacklogBaseline(t *testing.T) {
	mk := func(author, stamp string, seen ...string) *monItem {
		return &monItem{Author: author, Time: stamp, SeenBy: seen, Key: author + "|" + stamp, Text: stamp}
	}
	items := []*monItem{
		mk("Bouke", "09:00", "Tester"), // read
		mk("Bouke", "09:01"),           // unread
		mk("Tester", "09:02"),          // the agent's own
		mk("Bouke", "09:03"),           // unread
	}
	items[1].Bare = false
	base, skipped := monBacklogBaseline(items, "Tester")
	if skipped != 0 {
		t.Errorf("nothing should be capped for %d items, got %d", len(items), skipped)
	}
	if len(base) != 2 {
		t.Fatalf("baseline should hold only what was read or written by us, got %d: %+v", len(base), base)
	}
	for _, it := range base {
		if it.Time == "09:01" || it.Time == "09:03" {
			t.Errorf("unread comment %s stayed in the baseline, so it will never be delivered", it.Time)
		}
	}

	// a bare-tag reply is not a comment and must not be replayed as one
	tagged := []*monItem{mk("Bouke", "10:00")}
	tagged[0].Bare = true
	if base, _ := monBacklogBaseline(tagged, "Tester"); len(base) != 1 {
		t.Error("a bare-tag reply was treated as an unread comment")
	}

	// the cap keeps the NEWEST unread and reports the rest
	var many []*monItem
	for i := 0; i < monBacklogCap+5; i++ {
		many = append(many, mk("Bouke", fmt.Sprintf("09:%02d", i)))
	}
	base, skipped = monBacklogBaseline(many, "Tester")
	if skipped != 5 {
		t.Errorf("cap should have reported 5 skipped, got %d", skipped)
	}
	if len(base) != 5 {
		t.Errorf("the oldest 5 should stay in the baseline, got %d", len(base))
	}
	for _, it := range base {
		if it.Time > "09:04" {
			t.Errorf("the cap kept an old comment (%s) and dropped a newer one", it.Time)
		}
	}
}

// The scenario that cost a human half a day: a comment written while no
// monitor was listening must arrive when one starts, on the read-markers
// alone — no saved state, no replay bookkeeping.
func TestMonitorDeliversUnreadOnStart(t *testing.T) {
	exe := "./remark"
	if runtime.GOOS == "windows" {
		exe = "./remark.exe"
	}
	if _, err := os.Stat(exe); err != nil {
		t.Skip("no built binary next to the package — run task build first")
	}
	dir := t.TempDir()
	doc := filepath.Join(dir, "talk.md")
	// everything read except the one comment written during the blackout
	seed := "# Talk\n\n" +
		"- [ ] Bouke (2026-09-10 09:00:00): **Root** <!--thread--> <!--seen:Tester-->\n  the opening\n\n" +
		"  - Bouke (2026-09-10 09:26:44): written while nobody listened.\n\n" +
		"  - Bouke (2026-09-10 09:30:00): already read. <!--seen:Tester-->\n"
	if err := os.WriteFile(doc, []byte(seed), 0o644); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(exe, "monitor", "-as", "Tester", "-json", "-interval", "100ms", doc)
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

	seenStamps := make(chan string, 16)
	go func() {
		sc := bufio.NewScanner(out)
		for sc.Scan() {
			line := strings.TrimSpace(sc.Text())
			if !strings.HasPrefix(line, "{") {
				continue
			}
			var ev monEvent
			if json.Unmarshal([]byte(line), &ev) == nil && ev.Type == "comment" {
				seenStamps <- ev.Time
			}
		}
	}()
	select {
	case got := <-seenStamps:
		if got != "2026-09-10 09:26:44" {
			t.Errorf("delivered %q first; the unread comment should lead", got)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("the unread comment was never delivered — a restarted monitor still opens in silence")
	}
	// the already-read one must NOT be replayed
	select {
	case extra := <-seenStamps:
		t.Errorf("replayed a comment this identity had already read: %s", extra)
	case <-time.After(2 * time.Second):
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
	// already read, so the backlog stays quiet and this test sees only live
	// comments — what it is about
	seed := "# Talk\n\n- [ ] Bouke (2026-09-10 09:00:00): **Root** <!--thread--> <!--seen:Tester-->\n  the opening\n"
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
