package main

// remark query <file> [filters]: find the threads holding comments that match,
// and say only that — which thread, and which comments in it. Reading them is
// remark read's job, so this never repeats a body.
//
// The filters AND together and are meant to grow: a date window today, an
// author, a tag, a text match, and room for the next one beside them.
//
//	-days N                  activity in the last N days, today counting as 1
//	-since <date> -until <date>   an explicit window, both ends inclusive
//	-author <name>           comments signed by exactly this name
//	-tag <tag>               comments carrying the tag (reader tags included)
//	-text <substring>        case-insensitive match on the comment's text
//	-json                    one object per thread instead of lines

import (
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

type queryFilter struct {
	from, until      time.Time // zero means open-ended
	author, tag, sub string
}

func (q queryFilter) empty() bool {
	return q.from.IsZero() && q.until.IsZero() && q.author == "" && q.tag == "" && q.sub == ""
}

// queryDayStart is local midnight, so "the last 2 days" means whole days and
// not the last 48 hours — the same boundary the window's presets use.
func queryDayStart(t time.Time) time.Time {
	return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, t.Location())
}

func queryParseDate(s string) (time.Time, bool) {
	for _, layout := range []string{"2006-01-02", "2006-01-02 15:04", "2006-01-02 15:04:05"} {
		if t, err := time.ParseInLocation(layout, s, time.Local); err == nil {
			return t, true
		}
	}
	return time.Time{}, false
}

// queryNodeTime parses a comment's stamp; comments without one never match a
// date window (there is nothing to compare).
func queryNodeTime(n *readNode) (time.Time, bool) {
	if n.time == "" || n.time == "now" {
		return time.Time{}, false
	}
	return queryParseDate(strings.ReplaceAll(n.time, "T", " "))
}

func (q queryFilter) matches(lines []string, n *readNode) bool {
	if n.author == "" {
		return false // not a comment
	}
	if q.author != "" && n.author != q.author {
		return false
	}
	if !q.from.IsZero() || !q.until.IsZero() {
		t, ok := queryNodeTime(n)
		if !ok {
			return false
		}
		if !q.from.IsZero() && t.Before(q.from) {
			return false
		}
		if !q.until.IsZero() && t.After(q.until) {
			return false
		}
	}
	if q.tag != "" {
		tags, bare := readNodeTags(lines, n)
		if bare {
			return false // a reader tag is a label, not a comment
		}
		found := false
		for _, t := range tags {
			if t == q.tag {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	if q.sub != "" {
		body := readNodeBody(lines, n)
		if !strings.Contains(strings.ToLower(body), q.sub) {
			return false
		}
	}
	return true
}

type queryHit struct {
	Time   string `json:"time"`
	Author string `json:"author"`
}

type queryThread struct {
	Root    string     `json:"root"`
	Title   string     `json:"title,omitempty"`
	Author  string     `json:"author,omitempty"`
	Section string     `json:"section,omitempty"`
	Matches []queryHit `json:"matches"`
}

func runQuery(args []string) {
	var file string
	var q queryFilter
	asJSON := false
	days := -1
	next := func(i *int) string {
		if *i+1 < len(args) {
			*i++
			return args[*i]
		}
		fmt.Fprintf(os.Stderr, "remark query: %s needs a value\n", args[*i])
		os.Exit(2)
		return ""
	}
	for i := 0; i < len(args); i++ {
		a := args[i]
		if !strings.HasPrefix(a, "-") {
			if file == "" {
				file = a
				continue
			}
			fmt.Fprintf(os.Stderr, "remark query: unexpected %q\n", a)
			os.Exit(2)
		}
		switch strings.TrimLeft(a, "-") {
		case "days":
			v := next(&i)
			n, err := strconv.Atoi(v)
			if err != nil || n < 1 {
				fmt.Fprintf(os.Stderr, "remark query: -days wants a whole number of days, got %q\n", v)
				os.Exit(2)
			}
			days = n
		case "since":
			t, ok := queryParseDate(next(&i))
			if !ok {
				fmt.Fprintln(os.Stderr, "remark query: -since wants a date like 2026-09-14")
				os.Exit(2)
			}
			q.from = t
		case "until":
			v := args[i]
			t, ok := queryParseDate(next(&i))
			if !ok {
				fmt.Fprintf(os.Stderr, "remark query: %s wants a date like 2026-09-14\n", v)
				os.Exit(2)
			}
			// a bare date means the whole of that day
			if t.Equal(queryDayStart(t)) {
				t = t.Add(24*time.Hour - time.Second)
			}
			q.until = t
		case "author":
			q.author = next(&i)
		case "tag":
			q.tag = tagArg(next(&i))
			if q.tag == "" {
				fmt.Fprintln(os.Stderr, "remark query: -tag wants a tag like #important")
				os.Exit(2)
			}
		case "text":
			q.sub = strings.ToLower(next(&i))
		case "json":
			asJSON = true
		default:
			fmt.Fprintf(os.Stderr, "remark query: unknown flag %q\n", a)
			os.Exit(2)
		}
	}
	if days > 0 {
		if !q.from.IsZero() {
			fmt.Fprintln(os.Stderr, "remark query: use -days or -since, not both")
			os.Exit(2)
		}
		q.from = queryDayStart(time.Now().AddDate(0, 0, -(days - 1)))
	}
	if file == "" {
		fmt.Fprintln(os.Stderr, "usage: remark query <file> [-days N | -since <date> [-until <date>]]"+
			" [-author <name>] [-tag <tag>] [-text <substring>] [-json]")
		os.Exit(2)
	}
	if q.empty() {
		fmt.Fprintln(os.Stderr, "remark query: no filter given — that is every comment in the file; add -days, -since, -author, -tag or -text")
		os.Exit(2)
	}
	b, err := os.ReadFile(file)
	if err != nil {
		fmt.Fprintln(os.Stderr, "remark:", err)
		os.Exit(1)
	}
	lines, _, all := readParse(string(b))

	// group the matching comments under their thread root, keeping document
	// order in both
	var order []*readNode
	byRoot := map[*readNode][]queryHit{}
	for _, n := range all {
		if !q.matches(lines, n) {
			continue
		}
		root := n
		for root.parent != nil {
			root = root.parent
		}
		if _, seen := byRoot[root]; !seen {
			order = append(order, root)
		}
		byRoot[root] = append(byRoot[root], queryHit{Time: n.time, Author: n.author})
	}

	if asJSON {
		out := []queryThread{}
		for _, root := range order {
			out = append(out, queryThread{
				Root: root.time, Title: root.title, Author: root.author,
				Section: root.section, Matches: byRoot[root],
			})
		}
		j, err := json.Marshal(out)
		if err != nil {
			fmt.Fprintln(os.Stderr, "remark:", err)
			os.Exit(1)
		}
		fmt.Println(string(j))
		return
	}
	if len(order) == 0 {
		fmt.Println("no comments match")
		return
	}
	for _, root := range order {
		title := root.title
		if title == "" {
			title = readFirstLine(root)
		}
		fmt.Printf("%s  %s\n", root.time, title)
		for _, h := range byRoot[root] {
			fmt.Printf("    %s  %s\n", h.Time, h.Author)
		}
	}
	n := 0
	for _, hits := range byRoot {
		n += len(hits)
	}
	fmt.Printf("%d comment(s) in %d thread(s)\n", n, len(order))
}
