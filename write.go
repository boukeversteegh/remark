package main

// remark reply / remark thread: the write verbs. An agent that writes a
// comment by hand has to count an indent, place the item after the parent's
// whole body and keep every paragraph, fence and table line at the body
// indent — and gets one of those wrong often enough (the discussion file
// records three such faults in one evening). Here the tool typesets it.
//
//	remark reply  <file> <selector> -as <name> [-text t | -file p | stdin]
//	remark thread <file> -as <name> [-title t] [-plain]
//	              (-after <selector> | -section <heading> | -end) [-text|-file|stdin]
//
// The selector is what `remark read` accepts ("14:05:31", "16:58#2", "@1310").
// The new comment is stamped with a real, unique time and, for a reply, the
// agent's name is added to the parent's seen-marker — replying is the honest
// proof of having read it. The file is re-read right before writing and the
// write is retried if it changed underneath.

import (
	"fmt"
	"io"
	"os"
	"regexp"
	"strings"
	"time"
)

var (
	writeSeenRe  = regexp.MustCompile(`<!--\s*seen:\s*([^>]*?)\s*-->`)
	writeFenceRe = regexp.MustCompile("^\\s*(```|~~~)")
	// a body whose first line cannot sit inline after the author prefix
	writeBlockyRe = regexp.MustCompile("^(```|~~~|\\||#|>|[-*+] |\\d+[.)] |!\\[)")
)

type writeArgs struct {
	file, sel, as, text, textFile, title, after, section string
	end, plain, stdin                                    bool
}

func writeParseArgs(args []string) writeArgs {
	var a writeArgs
	var pos []string
	for i := 0; i < len(args); i++ {
		s := args[i]
		if !strings.HasPrefix(s, "-") {
			pos = append(pos, s)
			continue
		}
		key := strings.TrimLeft(s, "-")
		val := ""
		if j := strings.Index(key, "="); j >= 0 {
			key, val = key[:j], key[j+1:]
		} else if key != "end" && key != "plain" && key != "stdin" && i+1 < len(args) {
			i++
			val = args[i]
		}
		switch key {
		case "as":
			a.as = val
		case "text":
			a.text = val
		case "file":
			a.textFile = val
		case "title":
			a.title = val
		case "after":
			a.after = val
		case "section":
			a.section = val
		case "end":
			a.end = true
		case "plain":
			a.plain = true
		case "stdin":
			a.stdin = true
		default:
			fmt.Fprintf(os.Stderr, "remark: unknown flag -%s\n", key)
			os.Exit(2)
		}
	}
	if len(pos) > 0 {
		a.file = pos[0]
	}
	if len(pos) > 1 {
		a.sel = pos[1]
	}
	return a
}

// writeBody returns the comment text from -text, -file or stdin.
func writeBody(a writeArgs) string {
	switch {
	case a.text != "":
		return a.text
	case a.textFile != "":
		b, err := os.ReadFile(a.textFile)
		if err != nil {
			fmt.Fprintln(os.Stderr, "remark:", err)
			os.Exit(1)
		}
		return string(b)
	default:
		b, _ := io.ReadAll(os.Stdin)
		return string(b)
	}
}

// writeUniqueStamp picks the current second, bumping forward past stamps
// already present in the file.
func writeUniqueStamp(content string, now time.Time) string {
	taken := map[string]bool{}
	for _, m := range stampTakenRe.FindAllStringSubmatch(content, -1) {
		taken[m[1]] = true
	}
	t := now
	for taken[t.Format("2006-01-02 15:04:05")] {
		t = t.Add(time.Second)
	}
	return t.Format("2006-01-02 15:04:05")
}

// writeItemLines typesets one comment: the item line at indent, every body
// line re-indented to indent+2 (fences and tables included, verbatim inside).
func writeItemLines(indent int, checkbox bool, author, ts, title, body string) []string {
	pad := strings.Repeat(" ", indent)
	bodyPad := pad + "  "
	body = strings.ReplaceAll(body, "\r\n", "\n")
	body = strings.TrimRight(body, " \t\n")
	bodyLines := strings.Split(body, "\n")
	if body == "" {
		bodyLines = nil
	}
	bullet := "- "
	if checkbox {
		bullet = "- [ ] "
	}
	head := pad + bullet + author + " (" + ts + "):"
	var out []string
	inline := ""
	if title != "" {
		inline = "**" + strings.TrimSpace(strings.ReplaceAll(title, "**", "")) + "**"
	} else if len(bodyLines) > 0 && strings.TrimSpace(bodyLines[0]) != "" && !writeBlockyRe.MatchString(strings.TrimSpace(bodyLines[0])) {
		inline = strings.TrimSpace(bodyLines[0])
		bodyLines = bodyLines[1:]
	}
	if inline != "" {
		head += " " + inline
	}
	if checkbox && indent == 0 {
		head += " <!--thread-->"
	}
	out = append(out, head)
	// strip the common leading whitespace of the body, then re-indent
	minLead := -1
	inFence := false
	for _, l := range bodyLines {
		if strings.TrimSpace(l) == "" {
			continue
		}
		lead := len(l) - len(strings.TrimLeft(l, " \t"))
		if minLead < 0 || lead < minLead {
			minLead = lead
		}
	}
	if minLead < 0 {
		minLead = 0
	}
	for _, l := range bodyLines {
		if strings.TrimSpace(l) == "" {
			out = append(out, "")
			continue
		}
		if len(l) >= minLead {
			l = l[minLead:]
		}
		if writeFenceRe.MatchString(l) {
			inFence = !inFence
		}
		out = append(out, bodyPad+l)
	}
	_ = inFence
	return out
}

// writeAddSeen appends name to the seen-marker on line (creating one).
func writeAddSeen(line, name string) string {
	if name == "" {
		return line
	}
	if m := writeSeenRe.FindStringSubmatch(line); m != nil {
		for _, n := range strings.Split(m[1], ",") {
			if strings.TrimSpace(n) == name {
				return line
			}
		}
		names := strings.TrimSpace(m[1])
		if names != "" {
			names += ","
		}
		return strings.Replace(line, m[0], "<!--seen:"+names+name+"-->", 1)
	}
	return strings.TrimRight(line, " \t") + " <!--seen:" + name + "-->"
}

// writeInsert splices item lines into content at line index at (after
// trimming blank lines above it so exactly one blank separates), preserving
// the file's line ending.
func writeInsert(content string, at int, item []string) string {
	eol := "\n"
	if strings.Contains(content, "\r\n") {
		eol = "\r\n"
	}
	lines := strings.Split(strings.ReplaceAll(content, "\r\n", "\n"), "\n")
	if at > len(lines) {
		at = len(lines)
	}
	for at > 0 && strings.TrimSpace(lines[at-1]) == "" {
		at--
	}
	block := append([]string{""}, item...)
	if at >= len(lines) || strings.TrimSpace(lines[at]) != "" {
		block = append(block, "")
	}
	out := append([]string{}, lines[:at]...)
	out = append(out, block...)
	out = append(out, lines[at:]...)
	// a file that ended without a newline keeps ending with one now
	s := strings.Join(out, eol)
	if !strings.HasSuffix(s, eol) {
		s += eol
	}
	return s
}

// writeWithRetry runs compute on the file's current content and writes the
// result unless the file changed meanwhile, in which case it recomputes.
func writeWithRetry(file string, compute func(content string) (string, error)) {
	for attempt := 0; attempt < 3; attempt++ {
		b, err := os.ReadFile(file)
		if err != nil {
			fmt.Fprintln(os.Stderr, "remark:", err)
			os.Exit(1)
		}
		out, err := compute(string(b))
		if err != nil {
			fmt.Fprintln(os.Stderr, "remark:", err)
			os.Exit(1)
		}
		again, err := os.ReadFile(file)
		if err == nil && string(again) != string(b) {
			time.Sleep(150 * time.Millisecond)
			continue
		}
		if err := os.WriteFile(file, []byte(out), 0o644); err != nil {
			fmt.Fprintln(os.Stderr, "remark:", err)
			os.Exit(1)
		}
		return
	}
	fmt.Fprintln(os.Stderr, "remark: the file kept changing underneath — nothing written, try again")
	os.Exit(1)
}

func runReply(args []string) {
	a := writeParseArgs(args)
	if a.file == "" || a.sel == "" || a.as == "" {
		fmt.Fprintln(os.Stderr, "usage: remark reply <file> <selector> -as <name> [-text <text> | -file <path> | stdin]")
		os.Exit(2)
	}
	body := writeBody(a)
	if strings.TrimSpace(body) == "" {
		fmt.Fprintln(os.Stderr, "remark reply: empty body (use -text, -file or stdin)")
		os.Exit(2)
	}
	var stamp string
	var line int
	writeWithRetry(a.file, func(content string) (string, error) {
		lines, _, all := readParse(content)
		hits := readSelect(all, a.sel)
		switch {
		case len(hits) == 0:
			return "", fmt.Errorf("no comment matches %q", a.sel)
		case len(hits) > 1:
			var opts []string
			for i, n := range hits {
				opts = append(opts, fmt.Sprintf("%s#%d (@%d %s %s)", a.sel, i+1, n.start+1, n.author, readFirstLine(n)))
			}
			return "", fmt.Errorf("%q is ambiguous — pick one: %s", a.sel, strings.Join(opts, "; "))
		}
		parent := hits[0]
		stamp = writeUniqueStamp(content, time.Now())
		item := writeItemLines(parent.indent+2, false, a.as, stamp, "", body)
		lines[parent.start] = writeAddSeen(lines[parent.start], a.as)
		at := readSubtreeEnd(parent)
		content = strings.Join(lines, "\n")
		if strings.Contains(string(content), "\r\n") {
			content = strings.ReplaceAll(content, "\r\n", "\n")
		}
		out := writeInsert(content, at, item)
		line = strings.Count(out[:strings.Index(out, item[0])], "\n") + 1
		return out, nil
	})
	fmt.Printf("replied %s under %s at line %d\n", stamp, a.sel, line)
}

func runThread(args []string) {
	a := writeParseArgs(args)
	if a.file == "" || a.as == "" || (a.after == "" && a.section == "" && !a.end) {
		fmt.Fprintln(os.Stderr, "usage: remark thread <file> -as <name> [-title <t>] [-plain] (-after <selector> | -section <heading> | -end) [-text <text> | -file <path> | stdin]")
		os.Exit(2)
	}
	body := writeBody(a)
	if strings.TrimSpace(body) == "" && a.title == "" {
		fmt.Fprintln(os.Stderr, "remark thread: empty body (use -text, -file, stdin or -title)")
		os.Exit(2)
	}
	var stamp string
	var line int
	writeWithRetry(a.file, func(content string) (string, error) {
		lines, _, all := readParse(content)
		at := -1
		switch {
		case a.after != "":
			hits := readSelect(all, a.after)
			if len(hits) != 1 {
				return "", fmt.Errorf("-after %q matches %d comments; use an exact selector", a.after, len(hits))
			}
			root := hits[0]
			for root.parent != nil {
				root = root.parent
			}
			at = readSubtreeEnd(root)
		case a.section != "":
			level := 0
			for i, l := range lines {
				if m := monHeadRe.FindStringSubmatch(l); m != nil {
					if level > 0 && len(m[1]) <= level {
						at = i
						break
					}
					if level == 0 && strings.EqualFold(strings.TrimSpace(m[2]), strings.TrimSpace(a.section)) {
						level = len(m[1])
					}
				}
			}
			if level == 0 {
				return "", fmt.Errorf("no heading %q in the file", a.section)
			}
			if at < 0 {
				at = len(lines)
			}
		default:
			at = len(lines)
		}
		stamp = writeUniqueStamp(content, time.Now())
		item := writeItemLines(0, !a.plain, a.as, stamp, a.title, body)
		if a.plain {
			item[0] += " <!--thread-->"
		}
		out := writeInsert(strings.ReplaceAll(content, "\r\n", "\n"), at, item)
		line = strings.Count(out[:strings.Index(out, item[0])], "\n") + 1
		return out, nil
	})
	fmt.Printf("opened %s at line %d\n", stamp, line)
}
