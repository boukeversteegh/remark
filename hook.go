package main

// remark hook claude: the decision half of a Claude Code PreToolUse guard.
//
// A monitor is a STREAM. Started from a plain shell call it is either killed
// when that call times out, or its output is withheld until it dies — either
// way the comments never reach the agent, and nothing inside the process can
// tell the difference (a backgrounded reader drains the pipe perfectly well).
// The only place the mistake is visible is before it happens, in the tool
// call itself, which is what this answers.
//
// It reads the PreToolUse payload on stdin and prints a decision:
//
//	{"hookSpecificOutput":{"hookEventName":"PreToolUse",
//	  "permissionDecision":"deny","permissionDecisionReason":"…"}}
//
// Exit 0 either way — a hook that cannot parse its input must never block the
// tool it was meant to advise.

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"regexp"
	"strings"
)

type hookInput struct {
	ToolName  string `json:"tool_name"`
	ToolInput struct {
		Command string `json:"command"`
	} `json:"tool_input"`
}

// A real invocation is an executable token ending in "remark" (optionally
// .exe, with any path) followed by the monitor verb, at a command position —
// the start of the line or after a separator. `remark help monitor` is not
// one, because the verb there is "help".
//
// Quoting is where a naive pattern goes wrong in both directions: the
// executable is often quoted ("C:\…\remark.exe" monitor), while the words
// themselves appear inside quotes in commands that merely talk about them
// (echo 'run: remark monitor x'). So the quoted executable is matched first,
// and everything still inside quotes is then removed before looking for a
// bare one — a string being passed as data cannot launch anything.
var (
	hookQuotedExeRe = regexp.MustCompile(
		`(?i)(?:^|[\s;&|(])(?:"[^"]*remark(?:\.exe)?"|'[^']*remark(?:\.exe)?')\s+monitor(?:\s|$)`)
	hookBareExeRe = regexp.MustCompile(
		`(?i)(?:^|[\s;&|(])[^\s;&|()"']*remark(?:\.exe)?\s+monitor(?:\s|$)`)
	hookQuotedSpanRe = regexp.MustCompile(`"[^"]*"|'[^']*'`)
)

// hookEscape lets a human run it deliberately: anything carrying this token is
// none of the guard's business.
const hookEscape = "REMARK_HOOK_OK"

func hookIsMonitorCommand(cmd string) bool {
	if strings.Contains(cmd, hookEscape) {
		return false
	}
	if hookQuotedExeRe.MatchString(cmd) {
		return true
	}
	return hookBareExeRe.MatchString(hookQuotedSpanRe.ReplaceAllString(cmd, " "))
}

const hookDenyReason = "`remark monitor` is a STREAM, not a command that finishes. " +
	"Started from a shell call it is killed when that call times out, or its output is " +
	"held until it dies — either way the comments never reach you, and you cannot tell " +
	"from the outside that anything is wrong. Start it with the tool that delivers stdout " +
	"line by line while the process runs (Monitor, or whatever your harness calls it). " +
	"To run it from a shell anyway, include " + hookEscape + " in the command."

func runHook(args []string) {
	if len(args) == 0 || args[0] != "claude" {
		fmt.Fprintln(os.Stderr, "usage: remark hook claude   (reads a PreToolUse payload on stdin)")
		os.Exit(2)
	}
	b, err := io.ReadAll(os.Stdin)
	if err != nil {
		return // no input: say nothing, decide nothing
	}
	var in hookInput
	if json.Unmarshal(b, &in) != nil {
		return // not a payload we understand: never block on a guess
	}
	if !strings.EqualFold(in.ToolName, "Bash") || !hookIsMonitorCommand(in.ToolInput.Command) {
		return
	}
	out := map[string]any{
		"hookSpecificOutput": map[string]any{
			"hookEventName":            "PreToolUse",
			"permissionDecision":       "deny",
			"permissionDecisionReason": hookDenyReason,
		},
	}
	j, err := json.Marshal(out)
	if err != nil {
		return
	}
	fmt.Println(string(j))
}
