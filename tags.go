package main

// Tags: "#word" anywhere in a comment's text — a letter first, then letters,
// digits, "-" or "_"; never inside code spans, fenced code or URLs; "#123"
// is not a tag and neither is a "#r<digits>" comment reference. Tags are
// case-insensitive and canonicalised to lower case. A reply whose whole
// body is tags ("- Bouke (2026-09-06 22:14:06): #important #ui") is a
// reader tag: it tags its PARENT and is not a comment of its own.
//
// ui/parser.js carries the same rules for the window — keep both in step.
//
//	remark tag  <file> <selector> #a #b -as <name>   tag a comment (a bare-tag
//	                                                  reply, merged into yours)
//	remark tags <file>                                every tag with its count

import (
	"fmt"
	"os"
	"regexp"
	"sort"
	"strings"
	"time"
)

var (
	tagRe    = regexp.MustCompile(`(^|[^\w&/#])#([A-Za-z][\w-]*)`)
	tagRefRe = regexp.MustCompile(`^r\d*$`) // "#r…" comment references, and a bare "#r"
	// hex colors ("#eaf3ff") are not tags: 3-8 hex chars, at least one digit
	tagHexRe  = regexp.MustCompile(`^[a-f0-9]{3,8}$`)
	tagDigRe  = regexp.MustCompile(`\d`)
	tagCodeRe = regexp.MustCompile("`[^`\n]*`")
	tagURLRe  = regexp.MustCompile(`https?://\S+`)
	tagWordRe = regexp.MustCompile(`^#[A-Za-z][\w-]*$`)
)

// tagScannable strips fenced blocks, code spans and URLs.
func tagScannable(text string) string {
	var out []string
	inFence := false
	for _, l := range strings.Split(text, "\n") {
		if monFenceRe.MatchString(l) {
			inFence = !inFence
			continue
		}
		if !inFence {
			out = append(out, l)
		}
	}
	s := strings.Join(out, "\n")
	s = tagCodeRe.ReplaceAllString(s, " ")
	return tagURLRe.ReplaceAllString(s, " ")
}

// tagExtract returns the distinct tags in text, lower-cased, in order.
func tagExtract(text string) []string {
	seen := map[string]bool{}
	var out []string
	for _, m := range tagRe.FindAllStringSubmatch(tagScannable(text), -1) {
		t := strings.ToLower(strings.TrimRight(m[2], "-"))
		if t == "" || tagRefRe.MatchString(t) || seen[t] ||
			(tagHexRe.MatchString(t) && tagDigRe.MatchString(t)) {
			continue
		}
		seen[t] = true
		out = append(out, t)
	}
	return out
}

// tagIsBare reports whether text is nothing but tags.
func tagIsBare(text string) bool {
	words := strings.Fields(text)
	if len(words) == 0 {
		return false
	}
	for _, w := range words {
		if !tagWordRe.MatchString(w) || tagRefRe.MatchString(w[1:]) {
			return false
		}
	}
	return true
}

// tagUnion merges tag lists, keeping first-seen order.
func tagUnion(lists ...[]string) []string {
	seen := map[string]bool{}
	var out []string
	for _, l := range lists {
		for _, t := range l {
			if !seen[t] {
				seen[t] = true
				out = append(out, t)
			}
		}
	}
	return out
}

// tagDiff returns the entries of b that are not in a.
func tagDiff(a, b []string) []string {
	in := map[string]bool{}
	for _, t := range a {
		in[t] = true
	}
	var out []string
	for _, t := range b {
		if !in[t] {
			out = append(out, t)
		}
	}
	return out
}

// tagArg normalises a command-line tag ("#Important", "important") or
// returns "" when it is not a valid tag.
func tagArg(s string) string {
	s = strings.TrimPrefix(strings.TrimSpace(s), "#")
	if s == "" || !tagWordRe.MatchString("#"+s) || tagRefRe.MatchString(s) {
		return ""
	}
	return strings.ToLower(strings.TrimRight(s, "-"))
}

// readNodeBody returns a comment's own text (title line and all).
func readNodeBody(lines []string, n *readNode) string {
	var b []string
	for i := n.start; i < n.ownEnd && i < len(lines); i++ {
		l := lines[i]
		if i == n.start {
			l = n.text
		}
		b = append(b, strings.TrimSpace(l))
	}
	return strings.Join(b, "\n")
}

// readNodeTags: a node's effective tags (its own plus its bare-tag
// children's) and whether it is itself a bare tag.
func readNodeTags(lines []string, n *readNode) (tags []string, bare bool) {
	body := readNodeBody(lines, n)
	if n.parent != nil && tagIsBare(body) {
		return nil, true
	}
	tags = tagExtract(body)
	for _, c := range n.children {
		if _, cb := readNodeTags(lines, c); cb {
			tags = tagUnion(tags, tagExtract(readNodeBody(lines, c)))
		}
	}
	return tags, false
}

// remark tag <file> <selector> #a #b -as <name>
func runTag(args []string) {
	var file, sel, as string
	var tags []string
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "-as" || a == "--as":
			if i+1 < len(args) {
				as = args[i+1]
				i++
			}
		case strings.HasPrefix(a, "-as="):
			as = a[4:]
		case file == "":
			file = a
		case sel == "":
			sel = a
		default:
			t := tagArg(a)
			if t == "" {
				fmt.Fprintf(os.Stderr, "remark tag: %q is not a tag (a letter, then letters, digits, - or _)\n", a)
				os.Exit(2)
			}
			tags = append(tags, t)
		}
	}
	tags = tagUnion(tags)
	if file == "" || sel == "" || as == "" || len(tags) == 0 {
		fmt.Fprintln(os.Stderr, "usage: remark tag <file> <selector> #tag [#tag...] -as <name>")
		os.Exit(2)
	}
	var stamp, what string
	var line int
	writeWithRetry(file, func(content string) (string, error) {
		lines, _, all := readParse(content)
		hits := readSelect(all, sel)
		switch {
		case len(hits) == 0:
			return "", fmt.Errorf("no comment matches %q", sel)
		case len(hits) > 1:
			var opts []string
			for i, n := range hits {
				opts = append(opts, fmt.Sprintf("%s#%d (@%d %s %s)", sel, i+1, n.start+1, n.author, readFirstLine(n)))
			}
			return "", fmt.Errorf("%q is ambiguous — pick one: %s", sel, strings.Join(opts, "; "))
		}
		parent := hits[0]
		if _, bare := readNodeTags(lines, parent); bare {
			return "", fmt.Errorf("%q is itself a bare-tag reply; tag its parent instead", sel)
		}
		content = strings.Join(lines, "\n")
		// a bare-tag reply of yours under this comment already: add to it
		for _, c := range parent.children {
			if c.author != as {
				continue
			}
			body := readNodeBody(lines, c)
			if !tagIsBare(body) {
				continue
			}
			add := tagDiff(tagExtract(body), tags)
			if len(add) == 0 {
				return "", fmt.Errorf("%s already carries #%s from you", sel, strings.Join(tags, " #"))
			}
			// onto the reply's last text line (a body may sit on a
			// continuation line), keeping a first-line seen-marker last
			end := c.ownEnd - 1
			for end > c.start && strings.TrimSpace(lines[end]) == "" {
				end--
			}
			l := lines[end]
			marker := ""
			if m := writeSeenRe.FindStringIndex(l); m != nil {
				marker = " " + l[m[0]:m[1]]
				l = strings.TrimRight(l[:m[0]], " \t")
			}
			lines[end] = strings.TrimRight(l, " \t") + " #" + strings.Join(add, " #") + marker
			stamp = c.time
			line = c.start + 1
			what = "added #" + strings.Join(add, " #") + " to your tags"
			return strings.Join(lines, "\n"), nil
		}
		stamp = writeUniqueStamp(content, time.Now())
		item := writeItemLines(parent.indent+2, false, as, stamp, "", "#"+strings.Join(tags, " #"))
		lines[parent.start] = writeAddSeen(lines[parent.start], as)
		at := readSubtreeEnd(parent)
		out := writeInsert(strings.Join(lines, "\n"), at, item)
		line = strings.Count(out[:strings.Index(out, item[0])], "\n") + 1
		what = "tagged #" + strings.Join(tags, " #")
		return out, nil
	})
	if stamp != "" {
		writeLogNote(file, stamp)
	}
	fmt.Printf("%s on %s at line %d\n", what, sel, line)
}

// remark tags <file>: every tag with the number of comments carrying it
// (a bare-tag reply counts for its parent), most used first.
func runTags(args []string) {
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, "usage: remark tags <file>")
		os.Exit(2)
	}
	data, err := os.ReadFile(args[0])
	if err != nil {
		fmt.Fprintln(os.Stderr, "remark tags:", err)
		os.Exit(1)
	}
	lines, _, all := readParse(string(data))
	counts := map[string]int{}
	for _, n := range all {
		tags, bare := readNodeTags(lines, n)
		if bare {
			continue
		}
		for _, t := range tags {
			counts[t]++
		}
	}
	var names []string
	for t := range counts {
		names = append(names, t)
	}
	sort.Slice(names, func(i, j int) bool {
		if counts[names[i]] != counts[names[j]] {
			return counts[names[i]] > counts[names[j]]
		}
		return names[i] < names[j]
	})
	for _, t := range names {
		fmt.Printf("%4d  #%s\n", counts[t], t)
	}
}
