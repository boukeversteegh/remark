package main

// Which agent harness started this monitor, and what it would take to bring
// that conversation back.
//
// An agent that goes offline is a dead end today: the human can see the name
// greyed out and nothing else. The information needed to resume it is sitting
// in the monitor's own environment — Claude Code exports its session id, and
// a session id survives `--resume` unchanged (verified: one id across a whole
// transcript, through a context exhaustion and a re-login). So the monitor
// records who started it, which session, from where, and under which startup
// overrides, and a window can offer to bring it back.
//
// Three things this is careful about, all of them learned the hard way:
//
//   - An UNSET variable is a value. If CLAUDE_CONFIG_DIR was unset when the
//     agent started and remark's own process has one (the test harness sets
//     exactly this), resuming would hand Claude the wrong configuration
//     directory and look like it worked. So every override is recorded with
//     an explicit set/unset, and a resume must unset what was unset.
//   - Secrets are never stored. Anything whose name looks like a credential
//     is recorded as present-but-withheld. The value would otherwise reach a
//     file, a window and, in a group, other people.
//   - A pid is not an identity. Windows recycles them, and this project has
//     already acted on a stale one once. The harness process is recorded with
//     its start time, so "still running" means the same process, not merely
//     the same number.

import (
	"os"
	"path/filepath"
	"strings"
)

type harnessEnv struct {
	Name   string `json:"name"`
	Value  string `json:"value,omitempty"`
	Set    bool   `json:"set"`              // false is meaningful: resume must unset it
	Secret bool   `json:"secret,omitempty"` // set, and deliberately not stored
}

type harnessInfo struct {
	Tool     string       `json:"tool,omitempty"`    // "claude-code"
	Version  string       `json:"version,omitempty"` // as the harness reports it
	Session  string       `json:"session,omitempty"` // the resumable conversation id
	PID      int          `json:"pid,omitempty"`     // the harness process, not the monitor
	PIDStart string       `json:"pidStart,omitempty"`
	Cwd      string       `json:"cwd,omitempty"`
	Env      []harnessEnv `json:"env,omitempty"`
}

// harnessEnvKeys are the variables that change how Claude Code STARTS, as
// opposed to what it does once running. Each is recorded whether or not it is
// set, because resuming has to reproduce both cases.
var harnessEnvKeys = []string{
	"CLAUDE_CONFIG_DIR",
	"ANTHROPIC_BASE_URL",
	"ANTHROPIC_MODEL",
	"ANTHROPIC_SMALL_FAST_MODEL",
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
	"CLAUDE_CODE_USE_BEDROCK",
	"CLAUDE_CODE_USE_VERTEX",
	"AWS_PROFILE",
	"AWS_REGION",
	"CLOUD_ML_REGION",
	"ANTHROPIC_VERTEX_PROJECT_ID",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"NO_PROXY",
	"NODE_EXTRA_CA_CERTS",
	"CLAUDE_CODE_MAX_OUTPUT_TOKENS",
	"MAX_THINKING_TOKENS",
}

// harnessNotSecret are names the rule below would otherwise catch, and which
// are plainly counts rather than credentials. The list is deliberately short
// and explicit: every entry is a decision someone can audit, which is the
// only safe way to punch holes in a withhold-by-default rule.
var harnessNotSecret = map[string]bool{
	"MAX_THINKING_TOKENS":           true,
	"CLAUDE_CODE_MAX_OUTPUT_TOKENS": true,
}

// harnessSecretish decides by NAME alone, before any value is read. A name
// that could be a credential is treated as one: the cost of withholding a
// harmless value is that the human types it themselves; the cost of the
// reverse is a key in a file, on a screen, and in a screenshot.
func harnessSecretish(name string) bool {
	n := strings.ToUpper(name)
	if harnessNotSecret[n] {
		return false
	}
	for _, m := range []string{"KEY", "TOKEN", "SECRET", "PASSWORD", "PASSWD", "CREDENTIAL", "AUTH"} {
		if strings.Contains(n, m) {
			return true
		}
	}
	return false
}

// harnessDetect reads this process's environment. It returns nil when nothing
// recognisable started us — a monitor run from an ordinary shell is not an
// agent session and must not claim to be one.
func harnessDetect() *harnessInfo {
	session := os.Getenv("CLAUDE_CODE_SESSION_ID")
	isClaude := os.Getenv("CLAUDECODE") != "" || os.Getenv("CLAUDE_CODE_ENTRYPOINT") != "" || session != ""
	if !isClaude {
		return nil
	}
	h := &harnessInfo{Tool: "claude-code", Session: session}
	h.Version = harnessVersion(os.Getenv("AI_AGENT"))
	h.Cwd, _ = os.Getwd()
	if pid := atoiSafe(os.Getenv("CLAUDE_PID")); pid > 0 {
		// only worth recording while it is the process we think it is
		if pidAlive(pid) {
			h.PID = pid
			h.PIDStart = pidStartTime(pid)
		}
	}
	for _, k := range harnessEnvKeys {
		v, ok := os.LookupEnv(k)
		e := harnessEnv{Name: k, Set: ok}
		if ok {
			if harnessSecretish(k) {
				e.Secret = true
			} else {
				e.Value = v
			}
		}
		h.Env = append(h.Env, e)
	}
	return h
}

// harnessVersion pulls a version out of the harness's own label —
// "claude-code_2-1-220_agent" is 2.1.220. An unrecognised shape is returned
// whole rather than guessed at.
func harnessVersion(agent string) string {
	if agent == "" {
		return ""
	}
	parts := strings.Split(agent, "_")
	for _, p := range parts {
		if p == "" || !(p[0] >= '0' && p[0] <= '9') {
			continue
		}
		if strings.Count(p, "-") >= 1 {
			return strings.ReplaceAll(p, "-", ".")
		}
	}
	return agent
}

func atoiSafe(s string) int {
	n := 0
	for _, r := range s {
		if r < '0' || r > '9' {
			return 0
		}
		n = n*10 + int(r-'0')
	}
	if s == "" {
		return 0
	}
	return n
}

// harnessTranscript is where Claude Code keeps this session's transcript. It
// is a liveness signal a pid cannot give: the file's mtime is when the
// session last did anything, and it survives the monitor being stopped.
// Returns "" when the layout is not what we expect rather than guessing.
func harnessTranscript(h *harnessInfo) string {
	if h == nil || h.Tool != "claude-code" || h.Session == "" || h.Cwd == "" {
		return ""
	}
	base := ""
	for _, e := range h.Env {
		if e.Name == "CLAUDE_CONFIG_DIR" && e.Set {
			base = e.Value
		}
	}
	if base == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return ""
		}
		base = filepath.Join(home, ".claude")
	}
	p := filepath.Join(base, "projects", harnessProjectDir(h.Cwd), h.Session+".jsonl")
	if _, err := os.Stat(p); err != nil {
		return ""
	}
	return p
}

// harnessProjectDir mirrors how Claude Code escapes a working directory into
// a single path segment: every separator and colon becomes a dash.
func harnessProjectDir(cwd string) string {
	s := filepath.ToSlash(cwd)
	s = strings.ReplaceAll(s, ":", "-")
	s = strings.ReplaceAll(s, "/", "-")
	return s
}
