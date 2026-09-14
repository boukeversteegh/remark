package main

import (
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

// remark query: which threads hold comments that match, and which comments —
// never the bodies, which is what remark read is for.
func TestQuery(t *testing.T) {
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
	day := func(n int) string { return time.Now().AddDate(0, 0, -n).Format("2006-01-02") }
	doc := "# Q\n\n" +
		"- [ ] Bouke (" + day(0) + " 09:00:00): **Fresh** <!--thread-->\n" +
		"  opened today, about #sharing\n\n" +
		"  - Codex (" + day(0) + " 10:00:00): a reply today, mentioning WIDGETS.\n\n" +
		"- [ ] Bouke (" + day(3) + " 09:00:00): **Older** <!--thread-->\n" +
		"  three days back\n\n" +
		"  - Bouke (" + day(1) + " 11:00:00): answered yesterday.\n\n" +
		"- [ ] Codex (2026-01-05 09:00:00): **Ancient** <!--thread-->\n" +
		"  from january, about widgets\n\n" +
		"  - Bouke (2026-01-06 09:00:00): #sharing\n"
	dir := t.TempDir()
	p := filepath.Join(dir, "q.md")
	if err := os.WriteFile(p, []byte(doc), 0o644); err != nil {
		t.Fatal(err)
	}
	run := func(t *testing.T, args ...string) string {
		t.Helper()
		cmd := exec.Command(abs, append([]string{"query", p}, args...)...)
		cmd.Env = append(os.Environ(), "APPDATA="+dir, "LOCALAPPDATA="+dir,
			"XDG_CONFIG_HOME="+dir, "HOME="+dir, "USERPROFILE="+dir)
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("remark query %v failed: %v\n%s", args, err, out)
		}
		return string(out)
	}

	t.Run("days counts today as the first day", func(t *testing.T) {
		today := run(t, "-days", "1")
		if !strings.Contains(today, "Fresh") {
			t.Errorf("-days 1 missed today's thread:\n%s", today)
		}
		if strings.Contains(today, "answered yesterday") || strings.Contains(today, day(1)+" 11:00:00") {
			t.Errorf("-days 1 reached back into yesterday:\n%s", today)
		}
		// yesterday's reply pulls its OLD thread in — activity, not age
		since := run(t, "-days", "2")
		if !strings.Contains(since, "Older") || !strings.Contains(since, day(1)+" 11:00:00") {
			t.Errorf("-days 2 should include yesterday's reply and its thread:\n%s", since)
		}
		if strings.Contains(since, "Ancient") {
			t.Errorf("-days 2 reached back to january:\n%s", since)
		}
	})

	t.Run("an explicit window takes whole days at both ends", func(t *testing.T) {
		out := run(t, "-since", "2026-01-05", "-until", "2026-01-06")
		if !strings.Contains(out, "2026-01-05 09:00:00") || !strings.Contains(out, "2026-01-06 09:00:00") {
			t.Errorf("both ends should be inside the window:\n%s", out)
		}
		if strings.Contains(out, "Fresh") {
			t.Errorf("today's thread is outside january:\n%s", out)
		}
	})

	t.Run("author, tag and text each narrow it", func(t *testing.T) {
		// the thread header carries the ROOT's id whoever wrote it; only the
		// indented lines are matches, so those are what -author narrows
		byCodex := run(t, "-author", "Codex", "-days", "1")
		if !strings.Contains(byCodex, "    "+day(0)+" 10:00:00") {
			t.Errorf("-author should keep Codex's comment:\n%s", byCodex)
		}
		if strings.Contains(byCodex, "    "+day(0)+" 09:00:00") {
			t.Errorf("Bouke's comment matched an -author Codex filter:\n%s", byCodex)
		}
		// a reader tag counts for the comment it labels
		tagged := run(t, "-tag", "#sharing")
		if !strings.Contains(tagged, "Fresh") || !strings.Contains(tagged, "Ancient") {
			t.Errorf("-tag should find both the written and the reader tag:\n%s", tagged)
		}
		text := run(t, "-text", "widgets")
		if !strings.Contains(text, "Fresh") || !strings.Contains(text, "Ancient") {
			t.Errorf("-text should be case-insensitive:\n%s", text)
		}
	})

	t.Run("filters AND together", func(t *testing.T) {
		out := run(t, "-days", "1", "-author", "Bouke")
		if !strings.Contains(out, day(0)+" 09:00:00") {
			t.Errorf("Bouke wrote today's root:\n%s", out)
		}
		if strings.Contains(out, day(0)+" 10:00:00") {
			t.Errorf("Codex's comment survived an -author Bouke filter:\n%s", out)
		}
		none := run(t, "-days", "1", "-author", "Nobody")
		if !strings.Contains(none, "no comments match") {
			t.Errorf("an empty result should say so plainly:\n%s", none)
		}
	})

	t.Run("it lists ids, not bodies", func(t *testing.T) {
		out := run(t, "-days", "1")
		if strings.Contains(out, "mentioning WIDGETS") || strings.Contains(out, "opened today") {
			t.Errorf("query duplicated remark read's job:\n%s", out)
		}
		if !strings.Contains(out, "Fresh") {
			t.Errorf("the root's title is the one piece of prose it owes:\n%s", out)
		}
	})

	t.Run("-json carries the same answer in fields", func(t *testing.T) {
		var got []queryThread
		if err := json.Unmarshal([]byte(run(t, "-days", "1", "-json")), &got); err != nil {
			t.Fatalf("not json: %v", err)
		}
		if len(got) != 1 || got[0].Title != "Fresh" || len(got[0].Matches) != 2 {
			t.Fatalf("unexpected shape: %+v", got)
		}
		if got[0].Root != day(0)+" 09:00:00" || got[0].Matches[1].Author != "Codex" {
			t.Errorf("root id and match authors should be addressable: %+v", got)
		}
	})

	t.Run("no filter is refused rather than dumping the file", func(t *testing.T) {
		cmd := exec.Command(abs, "query", p)
		cmd.Env = append(os.Environ(), "APPDATA="+dir, "HOME="+dir, "USERPROFILE="+dir)
		out, err := cmd.CombinedOutput()
		if err == nil {
			t.Fatalf("a bare query should be refused:\n%s", out)
		}
		if !strings.Contains(string(out), "no filter") {
			t.Errorf("the refusal should say why: %s", out)
		}
	})

	t.Run("the UI presets map onto -days", func(t *testing.T) {
		// Today = -days 1, Since yesterday = -days 2, and the two week/month
		// presets: the help promises this, so it is worth pinning
		for _, n := range []int{1, 2, 7, 30} {
			if out := run(t, "-days", fmt.Sprint(n)); strings.Contains(out, "no comments match") && n >= 7 {
				t.Errorf("-days %d found nothing, but a thread was written three days ago:\n%s", n, out)
			}
		}
	})
}
