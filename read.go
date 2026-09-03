package main

// remark read — print comment threads from the command line, addressed by
// their timestamps (timestamps are comment identity: seconds precision,
// forced unique at write time by the composer).
//
//	remark read <file>                 index: every thread root, one line
//	remark read <file> <time...>       the matching comment + its subtree
//	  -depth N    limit subtree depth below the target (0 = the node alone)
//	  -parents    print full ancestor bodies instead of one-line breadcrumbs
//
// A selector matches a timestamp at component boundaries, so "22:18:07",
// "21:11", or "2026-09-03 21:11" all address comments; when a selector is
// ambiguous the matches are listed one per line to pick from. Pre-seconds
// comments can share a stamp for real, so two exact forms exist and the
// listing prints both per match: "16:58#2" is the nth match in document
// order, "@1310" the comment that owns file line 1310.

import (
	"fmt"
	"os"
	"regexp"
	"strconv"
	"strings"
)

type readNode struct {
	author, time, text, section, title string
	indent                             int
	start, ownEnd                      int // 0-based line span of the comment's own lines
	checked, resolvable                bool
	parent                             *readNode
	children                           []*readNode
}

func readParse(content string) (lines []string, roots []*readNode, all []*readNode) {
	lines = strings.Split(strings.ReplaceAll(content, "\r\n", "\n"), "\n")
	section := ""
	inFence := false
	rootIndent := -1
	var stack []*readNode
	var last *readNode

	closeLast := func(end int) {
		if last != nil && last.ownEnd == 0 {
			last.ownEnd = end
		}
	}
	flush := func(end int) {
		closeLast(end)
		rootIndent = -1
		stack = nil
		last = nil
	}

	for i, line := range lines {
		if monFenceRe.MatchString(line) {
			inFence = !inFence
			continue
		}
		if inFence {
			continue
		}
		if m := monHeadRe.FindStringSubmatch(line); m != nil {
			flush(i)
			section = strings.TrimSpace(m[2])
			continue
		}
		trimmed := strings.TrimLeft(line, " ")
		indent := len(line) - len(trimmed)
		isItem := false
		checked := false
		resolvable := false
		ind := 0
		text := ""
		if m := monItemRe.FindStringSubmatch(line); m != nil {
			isItem = true
			ind = len(m[1])
			text = m[3]
			checked = m[2] != " "
			resolvable = true
		} else if m := monPlainRe.FindStringSubmatch(line); m != nil {
			ind = len(m[1])
			text = m[2]
			stripped := monSeenRe.ReplaceAllString(text, "")
			if monMarkerRe.MatchString(stripped) {
				isItem = true
			} else if _, ts, _, ok := monParseAuthor(monMarkerRe.ReplaceAllString(stripped, "")); ok && ts != "" {
				isItem = true
			}
			if !isItem {
				if ind == 0 && rootIndent >= 0 {
					flush(i)
				}
				continue
			}
		}
		if isItem {
			text = strings.TrimSpace(monSeenRe.ReplaceAllString(text, ""))
			if ind == 0 {
				if !monIsRoot(text) {
					flush(i)
					continue
				}
				flush(i)
				rootIndent = 0
			} else if rootIndent < 0 {
				continue // nested item outside any thread (task list)
			}
			closeLast(i)
			author, ts, rest, _ := monParseAuthor(monMarkerRe.ReplaceAllString(text, ""))
			n := &readNode{
				author: author, time: ts, text: strings.TrimSpace(rest),
				section: section, indent: ind, start: i,
				checked: checked && resolvable, resolvable: resolvable,
			}
			for len(stack) > 0 && stack[len(stack)-1].indent >= ind {
				stack = stack[:len(stack)-1]
			}
			if len(stack) > 0 {
				n.parent = stack[len(stack)-1]
				n.parent.children = append(n.parent.children, n)
			} else {
				roots = append(roots, n)
			}
			stack = append(stack, n)
			all = append(all, n)
			last = n
			continue
		}
		if rootIndent >= 0 && last != nil && strings.TrimSpace(line) != "" && indent > last.indent {
			// body line; a root's bold first body line names the thread
			if last.indent == 0 && last.title == "" {
				if tm := monTitleRe.FindStringSubmatch(strings.TrimSpace(line)); tm != nil && last.text == "" {
					last.title = tm[1]
				} else if tm := monTitleRe.FindStringSubmatch(last.text); tm != nil {
					last.title = tm[1]
				}
			}
			continue
		}
		if rootIndent >= 0 && strings.TrimSpace(line) != "" && indent == 0 {
			flush(i)
		}
	}
	flush(len(lines))
	// titles for roots whose bold line sat inline
	for _, n := range roots {
		if n.title == "" {
			if tm := monTitleRe.FindStringSubmatch(n.text); tm != nil {
				n.title = tm[1]
			}
		}
	}
	return lines, roots, all
}

func readMatch(t, sel string) bool {
	if t == "" || sel == "" {
		return false
	}
	re, err := regexp.Compile(`(^|[ :\-])` + regexp.QuoteMeta(sel) + `($|[:\-])`)
	if err != nil {
		return false
	}
	return re.MatchString(t)
}

// readSelect resolves one selector against every comment: "@N" is the
// comment owning file line N, "sel#N" the nth timestamp match, anything
// else all timestamp matches (so the caller reports ambiguity).
func readSelect(all []*readNode, sel string) (hits []*readNode) {
	if strings.HasPrefix(sel, "@") {
		ln, err := strconv.Atoi(sel[1:])
		if err != nil {
			return nil
		}
		var best *readNode
		for _, n := range all { // deepest comment whose subtree spans line ln
			if n.start < ln && ln <= readSubtreeEnd(n) {
				if best == nil || n.start >= best.start {
					best = n
				}
			}
		}
		if best != nil {
			hits = append(hits, best)
		}
		return hits
	}
	nth := 0
	if i := strings.LastIndex(sel, "#"); i >= 0 {
		if v, err := strconv.Atoi(sel[i+1:]); err == nil && v > 0 {
			nth, sel = v, sel[:i]
		}
	}
	for _, n := range all {
		if readMatch(n.time, sel) {
			hits = append(hits, n)
		}
	}
	if nth > 0 {
		if nth > len(hits) {
			return nil
		}
		return hits[nth-1 : nth]
	}
	return hits
}

func readSubtreeEnd(n *readNode) int {
	for len(n.children) > 0 {
		n = n.children[len(n.children)-1]
	}
	return n.ownEnd
}

func readCountBelow(n *readNode) int {
	c := 0
	for _, ch := range n.children {
		c += 1 + readCountBelow(ch)
	}
	return c
}

func readFirstLine(n *readNode) string {
	s := n.title
	if s == "" {
		s = n.text
	}
	if len(s) > 72 {
		s = s[:72] + "…"
	}
	return s
}

func readPrintOwn(lines []string, n *readNode) {
	end := n.ownEnd
	for end > n.start && strings.TrimSpace(lines[end-1]) == "" {
		end--
	}
	for i := n.start; i < end; i++ {
		fmt.Printf("%5d│ %s\n", i+1, lines[i])
	}
}

func readPrintTree(lines []string, n *readNode, depth int) {
	readPrintOwn(lines, n)
	if depth == 0 {
		if c := readCountBelow(n); c > 0 {
			fmt.Printf("     │ %s… %d deeper repl%s hidden (raise -depth)\n",
				strings.Repeat(" ", n.indent+2), c, map[bool]string{true: "y", false: "ies"}[c == 1])
		}
		return
	}
	for _, ch := range n.children {
		readPrintTree(lines, ch, depth-1)
	}
}

func runRead(args []string) {
	depth := 1 << 30
	parents := false
	var file string
	var sels []string
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "-depth" || a == "--depth":
			if i+1 < len(args) {
				if v, err := strconv.Atoi(args[i+1]); err == nil {
					depth = v
				}
				i++
			}
		case a == "-parents" || a == "--parents":
			parents = true
		case file == "":
			file = a
		default:
			sels = append(sels, a)
		}
	}
	if file == "" {
		fmt.Fprintln(os.Stderr, "usage: remark read <file> [time...] [-depth N] [-parents]")
		os.Exit(2)
	}
	data, err := os.ReadFile(file)
	if err != nil {
		fmt.Fprintln(os.Stderr, "remark read:", err)
		os.Exit(1)
	}
	lines, roots, all := readParse(string(data))

	if len(sels) == 0 { // index: one line per thread root
		section := "\x00"
		for _, r := range roots {
			if r.section != section {
				section = r.section
				if section != "" {
					fmt.Printf("\n# %s\n", section)
				}
			}
			state := " - "
			if r.resolvable {
				state = "[ ]"
				if r.checked {
					state = "[x]"
				}
			}
			fmt.Printf("%s %-19s  %-12s %s  (%d repl%s)\n", state, r.time, r.author,
				readFirstLine(r), readCountBelow(r), map[bool]string{true: "y", false: "ies"}[readCountBelow(r) == 1])
		}
		return
	}

	seen := map[*readNode]bool{}
	for _, sel := range sels {
		hits := readSelect(all, sel)
		switch {
		case len(hits) == 0:
			fmt.Printf("no comment matches %q\n", sel)
		case len(hits) > 1:
			fmt.Printf("%q is ambiguous — %d matches, pick one by ordinal or line:\n", sel, len(hits))
			w := len(sel) + 1 + len(strconv.Itoa(len(hits)))
			for i, n := range hits {
				fmt.Printf("  %-*s  @%-5d  %-19s  %-12s %s\n", w, fmt.Sprintf("%s#%d", sel, i+1), n.start+1,
					n.time, n.author, readFirstLine(n))
			}
		default:
			n := hits[0]
			if seen[n] {
				continue
			}
			seen[n] = true
			// ancestry: full bodies with -parents, else one-line breadcrumbs
			var chain []*readNode
			for p := n.parent; p != nil; p = p.parent {
				chain = append([]*readNode{p}, chain...)
			}
			if n.section != "" {
				fmt.Printf("# %s\n", n.section)
			}
			for _, p := range chain {
				if parents {
					readPrintOwn(lines, p)
				} else {
					fmt.Printf("    ↳ %-19s  %-12s %s\n", p.time, p.author, readFirstLine(p))
				}
			}
			readPrintTree(lines, n, depth)
		}
	}
}
