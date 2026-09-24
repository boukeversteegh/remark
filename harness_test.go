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

func jsonString(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func envOf(h *harnessInfo, name string) (harnessEnv, bool) {
	for _, e := range h.Env {
		if e.Name == name {
			return e, true
		}
	}
	return harnessEnv{}, false
}

func TestHarnessDetectsClaudeCode(t *testing.T) {
	t.Setenv("CLAUDECODE", "1")
	t.Setenv("CLAUDE_CODE_SESSION_ID", "fdf52044-da39-4066-bb67-568807c13bd0")
	t.Setenv("AI_AGENT", "claude-code_2-1-220_agent")

	h := harnessDetect()
	if h == nil {
		t.Fatal("a monitor started by Claude Code should know it")
	}
	if h.Tool != "claude-code" {
		t.Errorf("tool: %q", h.Tool)
	}
	if h.Session != "fdf52044-da39-4066-bb67-568807c13bd0" {
		t.Errorf("session: %q", h.Session)
	}
	if h.Version != "2.1.220" {
		t.Errorf("version: %q — the harness label carries it", h.Version)
	}
}

// A monitor started from an ordinary shell is not a session, and must not
// offer to resume one.
func TestHarnessSilentWithoutAHarness(t *testing.T) {
	for _, k := range []string{"CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_ENTRYPOINT"} {
		t.Setenv(k, "")
		os.Unsetenv(k)
	}
	if h := harnessDetect(); h != nil {
		t.Errorf("claimed a session with nothing to go on: %+v", h)
	}
}

// Raised by Codex, 2026-09-24: an UNSET variable is a value. If
// CLAUDE_CONFIG_DIR was unset when the agent started and the resuming process
// has one of its own — remark's own test harness sets exactly this kind of
// variable — inheriting it would start Claude against the wrong configuration
// and look like it worked.
func TestHarnessRecordsUnsetAsAState(t *testing.T) {
	t.Setenv("CLAUDECODE", "1")
	t.Setenv("CLAUDE_CODE_SESSION_ID", "s1")
	os.Unsetenv("CLAUDE_CONFIG_DIR")

	h := harnessDetect()
	e, ok := envOf(h, "CLAUDE_CONFIG_DIR")
	if !ok {
		t.Fatal("an override that matters must be recorded even when unset")
	}
	if e.Set {
		t.Errorf("recorded as set: %+v", e)
	}
	if e.Value != "" {
		t.Errorf("an unset variable has no value: %+v", e)
	}

	t.Setenv("CLAUDE_CONFIG_DIR", filepath.Join(t.TempDir(), "cfg"))
	h = harnessDetect()
	if e, _ := envOf(h, "CLAUDE_CONFIG_DIR"); !e.Set || e.Value == "" {
		t.Errorf("a set override must carry its value: %+v", e)
	}
}

// discussion.md is public and a window shows this record; in a group, other
// people see the row. A credential must never be in it.
func TestHarnessWithholdsSecrets(t *testing.T) {
	t.Setenv("CLAUDECODE", "1")
	t.Setenv("CLAUDE_CODE_SESSION_ID", "s1")
	t.Setenv("ANTHROPIC_API_KEY", "sk-ant-not-a-real-key-000")
	t.Setenv("ANTHROPIC_AUTH_TOKEN", "bearer-not-a-real-token-000")
	t.Setenv("ANTHROPIC_BASE_URL", "https://example.internal")

	h := harnessDetect()
	for _, name := range []string{"ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"} {
		e, ok := envOf(h, name)
		if !ok {
			t.Fatalf("%s should be recorded as present", name)
		}
		if !e.Set || !e.Secret {
			t.Errorf("%s must be marked set-and-withheld: %+v", name, e)
		}
		if e.Value != "" {
			t.Errorf("%s LEAKED ITS VALUE: %q", name, e.Value)
		}
	}
	// and the harmless neighbour is still useful
	if e, _ := envOf(h, "ANTHROPIC_BASE_URL"); e.Value != "https://example.internal" {
		t.Errorf("a non-secret override should be shown: %+v", e)
	}
	// belt and braces: the whole record, serialised, holds neither secret
	for _, leak := range []string{"sk-ant-not-a-real-key-000", "bearer-not-a-real-token-000"} {
		if strings.Contains(jsonString(t, h), leak) {
			t.Errorf("the serialised record contains %q", leak)
		}
	}
}

func TestHarnessSecretishNames(t *testing.T) {
	secret := []string{"ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "AWS_SECRET_ACCESS_KEY",
		"GH_TOKEN", "MY_PASSWORD", "SOME_CREDENTIALS"}
	plain := []string{"CLAUDE_CONFIG_DIR", "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL",
		"HTTPS_PROXY", "AWS_REGION", "MAX_THINKING_TOKENS"}
	for _, s := range secret {
		if !harnessSecretish(s) {
			t.Errorf("%s should be treated as a credential", s)
		}
	}
	for _, p := range plain {
		if harnessSecretish(p) {
			t.Errorf("%s is not a credential — withholding it helps nobody", p)
		}
	}
}

// Raised by Codex, 2026-09-24: a stopped monitor does not mean the session
// ended. Offering to resume one whose Claude is still running would start a
// second copy of one conversation.
func TestHarnessAliveDistinguishesTheProcessFromThePid(t *testing.T) {
	if got := harnessAlive(nil); got != "" {
		t.Errorf("no harness, no claim: %q", got)
	}
	if got := harnessAlive(&harnessInfo{PID: 0}); got != "" {
		t.Errorf("no pid, no claim: %q", got)
	}

	// a live process, recorded honestly, reads as alive
	self := os.Getpid()
	start := pidStartTime(self)
	if start == "" {
		t.Skip("no process start time on this platform")
	}
	if got := harnessAlive(&harnessInfo{PID: self, PIDStart: start}); got != "yes" {
		t.Errorf("this very process should read as running: %q", got)
	}

	// THE BUG THIS PREVENTS: same pid, different process. A record whose
	// start time does not match the process now wearing that number is a
	// stale record, not a running session.
	if got := harnessAlive(&harnessInfo{PID: self, PIDStart: "1"}); got != "no" {
		t.Errorf("a recycled pid must not pass as the same process: %q", got)
	}

	// a pid that is genuinely gone
	cmd := exec.Command("cmd", "/c", "exit 0")
	if runtime.GOOS != "windows" {
		cmd = exec.Command("sh", "-c", "exit 0")
	}
	if err := cmd.Run(); err != nil {
		t.Fatal(err)
	}
	dead := cmd.Process.Pid
	deadline := time.Now().Add(3 * time.Second)
	for pidAlive(dead) && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
	}
	if pidAlive(dead) {
		t.Skip("the exited process is lingering; nothing to assert")
	}
	if got := harnessAlive(&harnessInfo{PID: dead, PIDStart: "1"}); got != "no" {
		t.Errorf("an exited process should read as gone: %q", got)
	}
}

// The transcript is a liveness signal a pid cannot give: it outlives the
// monitor and says when the session last did anything.
func TestHarnessTranscriptFollowsTheConfigDir(t *testing.T) {
	cfg := t.TempDir()
	cwd := filepath.Join(t.TempDir(), "proj")
	os.MkdirAll(cwd, 0o755)
	h := &harnessInfo{Tool: "claude-code", Session: "abc", Cwd: cwd,
		Env: []harnessEnv{{Name: "CLAUDE_CONFIG_DIR", Set: true, Value: cfg}}}

	if got := harnessTranscript(h); got != "" {
		t.Errorf("nothing on disk yet, so nothing to report: %q", got)
	}
	dir := filepath.Join(cfg, "projects", harnessProjectDir(cwd))
	os.MkdirAll(dir, 0o755)
	want := filepath.Join(dir, "abc.jsonl")
	os.WriteFile(want, []byte("{}\n"), 0o644)
	if got := harnessTranscript(h); got != want {
		t.Errorf("transcript: got %q, want %q", got, want)
	}

	// a session whose config dir was UNSET must not be looked for inside
	// whichever directory this process happens to use
	h.Env = []harnessEnv{{Name: "CLAUDE_CONFIG_DIR", Set: false}}
	if got := harnessTranscript(h); got == want {
		t.Error("an unset config dir resolved to the one that was set")
	}
}

func TestHarnessProjectDirEscaping(t *testing.T) {
	for in, want := range map[string]string{
		`D:\remark`:          "D--remark",
		"/home/u/p":          "-home-u-p",
		`C:\Users\v\my proj`: "C--Users-v-my proj",
	} {
		if got := harnessProjectDir(in); got != want {
			t.Errorf("%s: got %q, want %q", in, got, want)
		}
	}
}
