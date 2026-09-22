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

// The guard has exactly two ways to be wrong, and the second is worse: miss a
// real monitor launch, or block a command that was never one. Every line here
// is a command someone could plausibly type.
func TestHookRecognisesMonitorCommands(t *testing.T) {
	deny := []string{
		`remark monitor discussion.md -as Claude`,
		`remark.exe monitor discussion.md -as Claude`,
		`"C:\Users\v\AppData\Local\Programs\remark\remark.exe" monitor D:/p/TODO.md -as CIBuild -mine`,
		`'C:\Program Files\remark\remark' monitor notes.md`,
		`C:/Users/v/remark.exe monitor notes.md`,
		`./remark monitor notes.md -json`,
		`/usr/local/bin/remark monitor notes.md`,
		`cd D:/project && remark monitor notes.md -as Bot`,
		`remark monitor  notes.md`, // two spaces
		`REMARK=1 remark monitor notes.md`,
		`(remark monitor notes.md)`,
		`remark monitor`,             // no arguments yet, still a monitor
		`remark "monitor" notes.md`,  // the shell strips those quotes before remark sees them
		`remark mon"itor" notes.md`,  //
		`remark monitor notes.md &`,  // backgrounded, which changes nothing
		`remark monitor x | tee log`, //
		`remark monitor notes.md > out.txt 2>&1`,
		`nohup remark monitor notes.md`,
		`env REMARK_NAME=Bot remark monitor notes.md`,
		`bash -c "remark monitor notes.md"`,
		`bash -lc 'cd /p && remark monitor notes.md'`,
		"remark monitor notes.md\nls", // one of two lines
		`ls; remark monitor notes.md`,
	}
	for _, cmd := range deny {
		if !hookIsMonitorCommand(cmd) {
			t.Errorf("should be recognised as a monitor launch: %s", cmd)
		}
	}

	allow := []string{
		`remark help monitor`,                          // the help topic
		`remark --help`,                                //
		`echo "remark monitor notes.md"`,               // quoting it, not running it
		`echo 'run: remark monitor notes.md'`,          //
		`grep -r "remark monitor" docs/`,               // searching for it
		`cat README.md | grep monitor`,                 //
		`remark read notes.md`,                         // another verb
		`remark query notes.md -text "remark monitor"`, // the words as data
		`remark unseen notes.md -as Claude`,            //
		`monitor notes.md`,                             // not remark at all
		`git log --grep="remark monitor"`,              //
		`remarkable monitor notes.md`,                  // a different program
		`./remarkably monitor x`,                       //
		`remark monitor notes.md ` + hookEscape,        // deliberate, with the escape
		``,                                             //

		// Reported by Codex, 2026-09-22: whitespace is not a command
		// boundary, and an executable is its whole basename.
		`echo remark monitor notes.md`,
		`echo "remark" monitor notes.md`,
		`myremark monitor notes.md`,
		`./myremark monitor notes.md`,
		`remark-cli monitor notes.md`,

		// remark's own dispatch matches the verb exactly, so this one exits
		// with an error rather than hanging. Nothing here to prevent.
		`REMARK.EXE MONITOR notes.md`,

		// The same rule elsewhere: remark as somebody else's argument.
		`which remark monitor`,
		`ls remark monitor`,
		`printf '%s\n' remark monitor`,
		`# remark monitor notes.md`,   // a comment
		`ls # remark monitor notes.md`,
		`bash script.sh remark monitor`, // a script we have not read
		`REMARK=remark monitor notes.md`,

		// Past what this reader models — allowed on purpose, because a
		// guess that blocks is worse than a monitor that fails as it used to.
		`$REMARK monitor notes.md`,
		`"${REMARK_EXE}" monitor notes.md`,
		`$(which remark) monitor notes.md`,
		`echo "unterminated remark monitor notes.md`,
		`timeout 600 remark monitor notes.md`,
		`xargs remark monitor < files.txt`,
	}
	for _, cmd := range allow {
		if hookIsMonitorCommand(cmd) {
			t.Errorf("must NOT be blocked: %s", cmd)
		}
	}
}

// The tokeniser is the whole decision, so it is worth testing as itself.
func TestHookSplit(t *testing.T) {
	words := func(cmd string) [][]string {
		cmds, ok := hookSplit(cmd)
		if !ok {
			return nil
		}
		var out [][]string
		for _, c := range cmds {
			var w []string
			for _, x := range c {
				w = append(w, x.text)
			}
			out = append(out, w)
		}
		return out
	}
	eq := func(t *testing.T, cmd string, want ...[]string) {
		t.Helper()
		got := words(cmd)
		if len(got) != len(want) {
			t.Fatalf("%s: got %v, want %v", cmd, got, want)
		}
		for i := range want {
			if strings.Join(got[i], "\x00") != strings.Join(want[i], "\x00") {
				t.Errorf("%s: got %v, want %v", cmd, got[i], want[i])
			}
		}
	}
	eq(t, `remark "monitor" notes.md`, []string{"remark", "monitor", "notes.md"})
	eq(t, `echo "remark" monitor x`, []string{"echo", "remark", "monitor", "x"})
	eq(t, `"C:\Users\v\remark.exe" monitor x`, []string{`C:\Users\v\remark.exe`, "monitor", "x"})
	eq(t, `.\remark.exe monitor x`, []string{`.\remark.exe`, "monitor", "x"}) // a path, not an escape
	eq(t, `cd p && remark monitor x`, []string{"cd", "p"}, []string{"remark", "monitor", "x"})
	eq(t, `(remark monitor x)`, []string{"remark", "monitor", "x"})
	eq(t, `echo 'run: remark monitor x'`, []string{"echo", "run: remark monitor x"})
	eq(t, `remark monitor x  # note`, []string{"remark", "monitor", "x"})
	if _, ok := hookSplit(`echo "open`); ok {
		t.Error("an unterminated quote must be reported, not guessed at")
	}
	if cmds, _ := hookSplit(`$REMARK monitor x`); cmds[0][0].certain {
		t.Error("a word holding an expansion is not something we know")
	}
}

// End to end through the binary: the payload shape Claude Code actually sends,
// and a decision it can act on.
func TestHookDecision(t *testing.T) {
	exe := "./remark"
	if runtime.GOOS == "windows" {
		exe = "./remark.exe"
	}
	if _, err := os.Stat(exe); err != nil {
		t.Skip("no built binary next to the package — run task build first")
	}
	abs, _ := filepath.Abs(exe)
	run := func(t *testing.T, payload string) string {
		t.Helper()
		cmd := exec.Command(abs, "hook", "claude")
		cmd.Stdin = strings.NewReader(payload)
		dir := t.TempDir()
		cmd.Env = append(os.Environ(), "APPDATA="+dir, "HOME="+dir, "USERPROFILE="+dir)
		out, err := cmd.Output()
		if err != nil {
			t.Fatalf("hook failed: %v", err)
		}
		return strings.TrimSpace(string(out))
	}

	t.Run("denies a monitor launched from Bash", func(t *testing.T) {
		out := run(t, `{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"remark monitor notes.md -as Bot","run_in_background":true}}`)
		var got struct {
			H struct {
				Event  string `json:"hookEventName"`
				Dec    string `json:"permissionDecision"`
				Reason string `json:"permissionDecisionReason"`
			} `json:"hookSpecificOutput"`
		}
		if err := json.Unmarshal([]byte(out), &got); err != nil {
			t.Fatalf("not json: %v\n%s", err, out)
		}
		if got.H.Event != "PreToolUse" || got.H.Dec != "deny" {
			t.Errorf("unexpected decision: %+v", got.H)
		}
		if !strings.Contains(got.H.Reason, "STREAM") || !strings.Contains(got.H.Reason, hookEscape) {
			t.Errorf("the reason must explain and offer the way out: %s", got.H.Reason)
		}
	})

	t.Run("says nothing about anything else", func(t *testing.T) {
		for _, p := range []string{
			`{"tool_name":"Bash","tool_input":{"command":"remark read notes.md"}}`,
			`{"tool_name":"Edit","tool_input":{"command":"remark monitor notes.md"}}`, // not Bash
			`{"tool_name":"Bash","tool_input":{}}`,
			`not json at all`,
			``,
		} {
			if out := run(t, p); out != "" {
				t.Errorf("should have stayed silent for %q, said: %s", p, out)
			}
		}
	})
}
