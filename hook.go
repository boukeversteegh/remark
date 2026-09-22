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

// A real invocation is the remark executable IN COMMAND POSITION — the start
// of the line or after a separator — followed by the monitor verb. Neither
// half survives a regex over the raw string: `echo remark monitor x` puts the
// words after whitespace, `myremark monitor x` ends in the right letters, and
// removing quoted spans to find the executable destroys `remark "monitor" x`,
// which is a perfectly good monitor launch. So the line is tokenised the way
// a shell would, and the question is asked of the tokens.
//
// It is a deliberately limited reader, and everything it cannot resolve is
// ALLOWED: an unterminated quote, a `$VAR` where the program or verb belongs,
// a wrapper it does not know (timeout, xargs, watch). Missing a launch costs
// what the guard was already costing before it existed; blocking a command
// that was never a monitor costs the agent its work.

// hookWord is one shell word: its literal value, and whether we could work
// that value out at all.
type hookWord struct {
	text    string
	certain bool
}

var hookAssignRe = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*=`)

// These step aside without changing what is being launched.
var hookWrappers = map[string]bool{"nohup": true, "setsid": true, "exec": true, "command": true}

var hookShells = map[string]bool{"sh": true, "bash": true, "zsh": true, "dash": true, "ksh": true}

// hookEscape lets a human run it deliberately: anything carrying this token is
// none of the guard's business.
const hookEscape = "REMARK_HOOK_OK"

func hookIsMonitorCommand(cmd string) bool {
	if strings.Contains(cmd, hookEscape) {
		return false
	}
	return hookLaunchesMonitor(cmd, 0)
}

func hookLaunchesMonitor(cmd string, depth int) bool {
	cmds, ok := hookSplit(cmd)
	if !ok {
		return false // syntax we do not model: a parse we cannot trust denies nothing
	}
	for _, c := range cmds {
		if hookCommandLaunchesMonitor(c, depth) {
			return true
		}
	}
	return false
}

// hookSplit breaks a command line into simple commands, honouring quotes.
// ok is false when a quote is left open — at that point our reading and the
// shell's have parted company, and the guard should say nothing.
func hookSplit(cmd string) (cmds [][]hookWord, ok bool) {
	var (
		cur     []hookWord
		w       = hookWord{certain: true}
		started bool
	)
	endWord := func() {
		if started {
			cur = append(cur, w)
			w = hookWord{certain: true}
			started = false
		}
	}
	endCommand := func() {
		endWord()
		if len(cur) > 0 {
			cmds = append(cmds, cur)
			cur = nil
		}
	}
	rs := []rune(cmd)
	for i := 0; i < len(rs); i++ {
		c := rs[i]
		switch {
		case c == '\'':
			started = true
			j := i + 1
			for ; j < len(rs) && rs[j] != '\''; j++ {
				w.text += string(rs[j])
			}
			if j >= len(rs) {
				return nil, false
			}
			i = j
		case c == '"':
			started = true
			j := i + 1
			for ; j < len(rs) && rs[j] != '"'; j++ {
				if rs[j] == '\\' && j+1 < len(rs) && strings.ContainsRune("\"\\$`\n", rs[j+1]) {
					j++
					w.text += string(rs[j])
					continue
				}
				if rs[j] == '$' || rs[j] == '`' {
					w.certain = false
				}
				w.text += string(rs[j])
			}
			if j >= len(rs) {
				return nil, false
			}
			i = j
		case c == '\\':
			started = true
			if i+1 >= len(rs) {
				w.text += string(c)
				break
			}
			// A backslash before a shell metacharacter escapes it; before
			// anything else it is KEPT, because in the commands this guard
			// reads it is a Windows path separator far more often than an
			// escape (.\remark.exe, C:\Users\…\remark.exe).
			i++
			if strings.ContainsRune("\"'\\ \t\n$`&;|<>()", rs[i]) {
				w.text += string(rs[i])
			} else {
				w.text += string(c) + string(rs[i])
			}
		case c == '$' || c == '`':
			started = true
			w.certain = false
			w.text += string(c)
		case c == ' ' || c == '\t' || c == '\r', c == '<' || c == '>':
			endWord()
		case c == ';' || c == '|' || c == '&' || c == '(' || c == ')' || c == '\n':
			endCommand()
		case c == '#' && !started:
			for i+1 < len(rs) && rs[i+1] != '\n' {
				i++
			}
		default:
			started = true
			w.text += string(c)
		}
	}
	endCommand()
	return cmds, true
}

// hookBase is the executable's name: no directory, no .exe.
func hookBase(s string) string {
	if i := strings.LastIndexAny(s, `/\`); i >= 0 {
		s = s[i+1:]
	}
	if len(s) > 4 && strings.EqualFold(s[len(s)-4:], ".exe") {
		s = s[:len(s)-4]
	}
	return s
}

func hookCommandLaunchesMonitor(words []hookWord, depth int) bool {
	for len(words) > 0 && hookAssignRe.MatchString(words[0].text) {
		words = words[1:] // NAME=value belongs to the environment, not the command
	}
	for len(words) > 0 {
		if !words[0].certain {
			return false
		}
		base := strings.ToLower(hookBase(words[0].text))
		switch {
		case base == "remark":
			// The verb is matched EXACTLY, because remark's own dispatch does:
			// `remark MONITOR x` exits with an error, it does not hang, and a
			// guard that blocks it is blocking nothing worth blocking.
			return len(words) > 1 && words[1].certain && words[1].text == "monitor"
		case hookWrappers[base]:
			words = words[1:]
		case base == "env":
			words = words[1:]
			for len(words) > 0 && hookAssignRe.MatchString(words[0].text) {
				words = words[1:]
			}
			if len(words) > 0 && strings.HasPrefix(words[0].text, "-") {
				return false // env's own options: past what this reader models
			}
		case hookShells[base] && depth < 2:
			return hookShellDashC(words[1:], depth)
		default:
			return false // something else is being launched; remark is its argument
		}
	}
	return false
}

// hookShellDashC follows `bash -c "…"` into the string it runs, and nothing
// else: a script path is a file we have not read, not a command we can judge.
func hookShellDashC(rest []hookWord, depth int) bool {
	for i, w := range rest {
		if !strings.HasPrefix(w.text, "-") {
			return false
		}
		if strings.Contains(w.text, "c") && i+1 < len(rest) {
			return rest[i+1].certain && hookLaunchesMonitor(rest[i+1].text, depth+1)
		}
	}
	return false
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
