package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// The matrix Codex asked for on 2026-09-24: two sessions in the same
// directory, and one started with a non-default CLAUDE_CONFIG_DIR. Real
// monitor processes, real presence records — the earlier tests exercise the
// detection function, and this one proves the value survives the trip from a
// process environment, through a monitor, into the record a window reads.
func TestHarnessLiveMonitorsRecordTheirOwnSession(t *testing.T) {
	exe := "./remark"
	if runtime.GOOS == "windows" {
		exe = "./remark.exe"
	}
	if _, err := os.Stat(exe); err != nil {
		t.Skip("no built binary next to the package — run task build first")
	}
	abs, _ := filepath.Abs(exe)

	work := t.TempDir()             // ONE directory, two sessions in it
	doc := filepath.Join(work, "d.md")
	os.WriteFile(doc, []byte("# D\n\ntext.\n\n- [ ] Me (2026-09-20 09:00:00): **T** x <!--thread-->\n"), 0o644)

	altConfig := filepath.Join(t.TempDir(), "alt-claude")
	os.MkdirAll(altConfig, 0o755)

	type want struct {
		name, session, configDir string
		configSet                bool
	}
	cases := []want{
		{name: "AgentDefault", session: "1111aaaa-0000-0000-0000-000000000001", configSet: false},
		{name: "AgentAlt", session: "2222bbbb-0000-0000-0000-000000000002", configSet: true, configDir: altConfig},
	}

	// each monitor gets its own remark config dir so their presence records
	// do not land in the developer's real one
	remarkCfg := t.TempDir()
	var procs []*exec.Cmd
	for _, c := range cases {
		cmd := exec.Command(abs, "monitor", doc, "-as", c.name)
		env := append(os.Environ(),
			"APPDATA="+remarkCfg, "XDG_CONFIG_HOME="+remarkCfg,
			"CLAUDECODE=1",
			"CLAUDE_CODE_SESSION_ID="+c.session,
			"AI_AGENT=claude-code_2-1-220_agent",
		)
		if c.configSet {
			env = append(env, "CLAUDE_CONFIG_DIR="+c.configDir)
		} else {
			// the trap: this process may well have one, and an inherited
			// value would look exactly like a correct reading
			env = append(env, "CLAUDE_CONFIG_DIR=")
			env = filterEnv(env, "CLAUDE_CONFIG_DIR")
		}
		cmd.Env = env
		cmd.Dir = work
		cmd.Stdout = nil
		if err := cmd.Start(); err != nil {
			t.Fatalf("could not start a monitor: %v", err)
		}
		procs = append(procs, cmd)
	}
	defer func() {
		for _, p := range procs {
			if p.Process != nil {
				p.Process.Kill()
				p.Wait()
			}
		}
	}()

	pdir := filepath.Join(remarkCfg, "remark", "presence")
	got := map[string]presenceInfo{}
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) && len(got) < len(cases) {
		ents, _ := os.ReadDir(pdir)
		for _, e := range ents {
			b, err := os.ReadFile(filepath.Join(pdir, e.Name()))
			if err != nil {
				continue
			}
			var info presenceInfo
			if json.Unmarshal(b, &info) == nil && info.Harness != nil {
				got[info.Name] = info
			}
		}
		if len(got) < len(cases) {
			time.Sleep(200 * time.Millisecond)
		}
	}

	for _, c := range cases {
		info, ok := got[c.name]
		if !ok {
			t.Errorf("%s never recorded a harness", c.name)
			continue
		}
		h := info.Harness
		// TWO SESSIONS, ONE DIRECTORY: each must report its own, or the
		// resume offered for one would reopen the other
		if h.Session != c.session {
			t.Errorf("%s: session %q, want %q", c.name, h.Session, c.session)
		}
		if h.Tool != "claude-code" || h.Version != "2.1.220" {
			t.Errorf("%s: tool %q %q", c.name, h.Tool, h.Version)
		}
		if presenceNormPath(h.Cwd) != presenceNormPath(work) {
			t.Errorf("%s: cwd %q, want %q", c.name, h.Cwd, work)
		}
		var cd harnessEnv
		for _, e := range h.Env {
			if e.Name == "CLAUDE_CONFIG_DIR" {
				cd = e
			}
		}
		if cd.Name == "" {
			t.Errorf("%s: CLAUDE_CONFIG_DIR not recorded at all", c.name)
			continue
		}
		if cd.Set != c.configSet {
			t.Errorf("%s: config dir recorded set=%v, want %v (value %q)", c.name, cd.Set, c.configSet, cd.Value)
		}
		if c.configSet && cd.Value != c.configDir {
			t.Errorf("%s: config dir %q, want %q", c.name, cd.Value, c.configDir)
		}
		if !c.configSet && cd.Value != "" {
			t.Errorf("%s: an unset config dir picked up %q — resuming would use the wrong configuration", c.name, cd.Value)
		}
	}

	// the two sessions must not have been conflated into one row's worth of
	// information just because they share a directory
	if len(got) == 2 {
		a, b := got[cases[0].name].Harness, got[cases[1].name].Harness
		if a.Session == b.Session {
			t.Error("two monitors in one directory reported the same session")
		}
	}
}

func filterEnv(env []string, drop string) []string {
	out := env[:0:0]
	for _, e := range env {
		if strings.HasPrefix(e, drop+"=") {
			continue
		}
		out = append(out, e)
	}
	return out
}
