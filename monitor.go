package main

// remark monitor <files...>: headless watcher built for AI agents (e.g. a
// Claude hook or Monitor command). Emits one line per new comment,
// resolution toggle, or seen-state change, with author/section/thread
// context, and can filter out the agent's own writes via -ignore-author —
// so the agent only wakes up for things the human did.

import (
	"crypto/sha256"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unicode"
)

// monNormAuthor makes author matching forgiving: case-insensitive, and any
// leading emoji/symbol prefix is ignored, so `-ignore-author claude` matches
// "🤖 Claude".
func monNormAuthor(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	i := strings.IndexFunc(s, func(r rune) bool { return unicode.IsLetter(r) || unicode.IsDigit(r) })
	if i > 0 {
		s = s[i:]
	}
	return s
}

type monItem struct {
	Author     string   `json:"author"`
	Time       string   `json:"time,omitempty"`
	Checked    bool     `json:"checked"` // resolved; only meaningful when Resolvable
	Resolvable bool     `json:"resolvable"`
	SeenBy     []string `json:"seenBy,omitempty"`
	Section    string   `json:"section,omitempty"`
	Thread     string   `json:"thread,omitempty"`
	Text       string   `json:"text"`
	indent     int
	key        string
}

var (
	monItemRe        = regexp.MustCompile(`^(\s*)- \[( |x|X)\] (.*)$`)
	monPlainRe       = regexp.MustCompile(`^(\s*)- (.*)$`)
	monHeadRe        = regexp.MustCompile(`^(#{1,6})\s+(.*)$`)
	monFenceRe       = regexp.MustCompile("^\\s*(```|~~~)")
	monMarkerRe      = regexp.MustCompile(`<!--\s*(?:rv|thread)\s*-->`)
	monSeenRe        = regexp.MustCompile(`<!--\s*seen:([^>]*?)\s*-->`)
	monAuthorRe      = regexp.MustCompile(`^(.{1,48}?):\s+(.*)$`)
	monAuthorEmptyRe = regexp.MustCompile(`^(.{1,48}?):\s*$`)
	monTimeRe        = regexp.MustCompile(`\s*\((\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?)\)$`)
	monTitleRe       = regexp.MustCompile(`^\*\*([^*].*?)\*\*\s*$`)
	monSpaceRe       = regexp.MustCompile(`\s+`)
	monSymbolRe      = regexp.MustCompile(`^[A-Za-z0-9]`)
)

func monNormalize(s string) string {
	s = monSeenRe.ReplaceAllString(s, "")
	s = monMarkerRe.ReplaceAllString(s, "")
	s = monSpaceRe.ReplaceAllString(s, " ")
	return strings.TrimSpace(s)
}

// monParseSeen extracts the names from a <!--seen:...--> marker, if present.
func monParseSeen(s string) []string {
	m := monSeenRe.FindStringSubmatch(s)
	if m == nil {
		return nil
	}
	var names []string
	for _, n := range strings.Split(m[1], ",") {
		if n = strings.TrimSpace(n); n != "" {
			names = append(names, n)
		}
	}
	return names
}

// monSameSet reports whether two name lists contain the same names,
// ignoring order.
func monSameSet(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	counts := map[string]int{}
	for _, x := range a {
		counts[x]++
	}
	for _, x := range b {
		counts[x]--
		if counts[x] < 0 {
			return false
		}
	}
	return true
}

func monParseAuthor(line string) (author, timeStr, rest string, ok bool) {
	m := monAuthorRe.FindStringSubmatch(line)
	if m == nil {
		// "Author (ts):" with an empty rest — the writer's form for bodies
		// that cannot sit inline (fences, lists); timestamped prefixes only.
		if em := monAuthorEmptyRe.FindStringSubmatch(line); em != nil && monTimeRe.MatchString(em[1]) {
			m = []string{em[0], em[1], ""}
		} else {
			return "", "", line, false
		}
	}
	name := strings.TrimSpace(m[1])
	if strings.ContainsAny(name, "`[]*") || strings.HasSuffix(strings.ToLower(name), "http") ||
		strings.HasSuffix(strings.ToLower(name), "https") {
		return "", "", line, false
	}
	if tm := monTimeRe.FindStringSubmatch(name); tm != nil {
		timeStr = tm[1]
		name = strings.TrimSpace(name[:len(name)-len(tm[0])])
	}
	return name, timeStr, m[2], true
}

func monIsRoot(text string) bool {
	if monMarkerRe.MatchString(text) {
		return true
	}
	author, _, _, ok := monParseAuthor(text)
	if !ok || len(author) > 24 {
		return false
	}
	words := strings.Fields(author)
	if len(words) == 1 {
		return true
	}
	return !monSymbolRe.MatchString(author) && len(words) <= 3
}

// monParse extracts all comment items with their context.
func monParse(content string) []*monItem {
	lines := strings.Split(strings.ReplaceAll(content, "\r\n", "\n"), "\n")
	var items []*monItem
	section := ""
	inFence := false
	rootIndent := -1 // -1 = not inside a thread
	threadLabel := ""
	var last *monItem

	flushThread := func() { rootIndent = -1; threadLabel = ""; last = nil }

	for _, line := range lines {
		if monFenceRe.MatchString(line) {
			inFence = !inFence
			continue
		}
		if inFence {
			continue
		}
		if m := monHeadRe.FindStringSubmatch(line); m != nil {
			section = strings.TrimSpace(m[2])
			flushThread()
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
			// plain list item: a comment only if (marker-stripped) text has an
			// author prefix or carries a thread/rv marker; otherwise ordinary
			// list content.
			ind = len(m[1])
			text = m[2]
			stripped := monSeenRe.ReplaceAllString(text, "")
			if monMarkerRe.MatchString(stripped) {
				isItem = true
			} else if _, ts, _, ok := monParseAuthor(monMarkerRe.ReplaceAllString(stripped, "")); ok && ts != "" {
				// timestamp required, or body bullets like "- Homepage: intro"
				// would read as comments by author "Homepage"
				isItem = true
			}
			if !isItem {
				if ind == 0 && rootIndent >= 0 {
					flushThread()
				}
				continue
			}
		}
		if isItem {
			seenBy := monParseSeen(text)
			text = strings.TrimSpace(monSeenRe.ReplaceAllString(text, ""))
			if ind == 0 {
				if !monIsRoot(text) {
					flushThread()
					continue
				}
				rootIndent = 0
			} else if rootIndent < 0 {
				continue // nested item outside any thread (task list)
			}
			author, ts, rest, _ := monParseAuthor(monMarkerRe.ReplaceAllString(text, ""))
			it := &monItem{
				Author: author, Time: ts,
				Checked: checked && resolvable, Resolvable: resolvable,
				SeenBy:  seenBy,
				Section: section, indent: ind,
				Text: strings.TrimSpace(rest),
			}
			if ind == 0 {
				threadLabel = ""
			}
			it.Thread = threadLabel
			it.key = monNormalize(author + "|" + rest)
			items = append(items, it)
			last = it
			continue
		}
		// continuation line inside a thread
		if rootIndent >= 0 && last != nil && strings.TrimSpace(line) != "" && indent > last.indent {
			cont := strings.TrimSpace(line)
			if last.indent == 0 && last.Text != "" && threadLabel == "" {
				if tm := monTitleRe.FindStringSubmatch(last.Text); tm != nil {
					threadLabel = tm[1]
					last.Thread = threadLabel
					last.Text = cont
					last.key = monNormalize(last.Author + "|" + cont)
					continue
				}
			}
			if len(last.Text) < 400 {
				last.Text = strings.TrimSpace(last.Text + " " + cont)
			}
			continue
		}
		if rootIndent >= 0 && strings.TrimSpace(line) != "" && indent == 0 {
			flushThread()
		}
	}
	// resolve thread labels: items inherit their root's title or author
	var curLabel string
	for _, it := range items {
		if it.indent == 0 {
			if it.Thread != "" {
				curLabel = it.Thread
			} else {
				curLabel = "thread by " + it.Author
			}
		}
		it.Thread = curLabel
	}
	return items
}

type monEvent struct {
	Type    string   `json:"type"` // comment | toggle | seen
	File    string   `json:"file"`
	Author  string   `json:"author"`
	Time    string   `json:"time,omitempty"`
	Checked bool     `json:"checked"`
	SeenBy  []string `json:"seenBy,omitempty"`
	Section string   `json:"section,omitempty"`
	Thread  string   `json:"thread,omitempty"`
	Text    string   `json:"text"`
}

func monDiff(file string, oldItems, newItems []*monItem) []monEvent {
	old := map[string]*monItem{}
	for _, it := range oldItems {
		old[it.key] = it
	}
	var evs []monEvent
	for _, it := range newItems {
		prev, existed := old[it.key]
		if !existed {
			evs = append(evs, monEvent{Type: "comment", File: file, Author: it.Author,
				Time: it.Time, Checked: it.Checked, Section: it.Section, Thread: it.Thread, Text: it.Text})
			continue
		}
		if it.Resolvable && prev.Checked != it.Checked {
			evs = append(evs, monEvent{Type: "toggle", File: file, Author: it.Author,
				Time: it.Time, Checked: it.Checked, Section: it.Section, Thread: it.Thread, Text: it.Text})
		}
		if !monSameSet(prev.SeenBy, it.SeenBy) {
			evs = append(evs, monEvent{Type: "seen", File: file, Author: it.Author,
				Time: it.Time, Checked: it.Checked, SeenBy: it.SeenBy,
				Section: it.Section, Thread: it.Thread, Text: it.Text})
		}
	}
	return evs
}

func runMonitor(args []string) {
	fs := flag.NewFlagSet("monitor", flag.ExitOnError)
	as := fs.String("as", "", "the agent's own author name: announces presence and implies -ignore-author for it")
	ignore := fs.String("ignore-author", "", "comma-separated authors whose changes are not reported (deprecated alias: prefer -as)")
	asJSON := fs.Bool("json", false, "emit NDJSON instead of human-readable lines")
	interval := fs.Duration("interval", 300*time.Millisecond, "poll interval")

	// accept flags before or after the file arguments
	var flagArgs, fileArgs []string
	for i := 0; i < len(args); i++ {
		a := args[i]
		if strings.HasPrefix(a, "-") {
			flagArgs = append(flagArgs, a)
			needsValue := !strings.Contains(a, "=") &&
				(strings.Contains(a, "ignore-author") || strings.Contains(a, "interval") ||
					strings.TrimLeft(a, "-") == "as")
			if needsValue && i+1 < len(args) {
				i++
				flagArgs = append(flagArgs, args[i])
			}
		} else {
			fileArgs = append(fileArgs, a)
		}
	}
	fs.Parse(flagArgs)

	var files []string
	seen := map[string]bool{}
	for _, pat := range fileArgs {
		matches, _ := filepath.Glob(pat)
		if matches == nil {
			matches = []string{pat}
		}
		for _, m := range matches {
			abs, err := filepath.Abs(m)
			if err == nil && !seen[abs] {
				seen[abs] = true
				files = append(files, abs)
			}
		}
	}
	if len(files) == 0 {
		fmt.Fprintln(os.Stderr, "remark monitor: no files matched")
		os.Exit(1)
	}

	ignored := map[string]bool{}
	for _, n := range strings.Split(*ignore, ",") {
		if n = strings.TrimSpace(n); n != "" {
			ignored[monNormAuthor(n)] = true
		}
	}
	if *as != "" {
		// identity: self-exclusion plus one presence heartbeat covering the
		// whole monitoring scope (patterns stay patterns — a glob monitor is
		// one participant, not one per matched file)
		ignored[monNormAuthor(*as)] = true
		stop := make(chan struct{})
		defer close(stop)
		presenceAnnounce(*as, "agent", fileArgs, files, stop)
	}

	type fileState struct {
		hash  [32]byte
		items []*monItem
	}
	states := map[string]*fileState{}
	for _, f := range files {
		st := &fileState{}
		if b, err := os.ReadFile(f); err == nil {
			st.hash = sha256.Sum256(b)
			st.items = monParse(string(b))
		}
		states[f] = st
	}
	fmt.Fprintf(os.Stderr, "remark monitor: watching %d file(s)\n", len(files))

	oneLine := func(s string) string {
		s = strings.ReplaceAll(s, "\n", " ")
		if len(s) > 400 {
			s = s[:400] + "…"
		}
		return s
	}

	for {
		time.Sleep(*interval)
		for _, f := range files {
			b, err := os.ReadFile(f)
			if err != nil {
				continue
			}
			h := sha256.Sum256(b)
			st := states[f]
			if h == st.hash {
				continue
			}
			items := monParse(string(b))
			for _, ev := range monDiff(filepath.Base(f), st.items, items) {
				if ignored[monNormAuthor(ev.Author)] {
					continue
				}
				if *asJSON {
					j, _ := json.Marshal(ev)
					fmt.Println(string(j))
				} else {
					mark := "💬"
					suffix := ""
					switch ev.Type {
					case "toggle":
						if ev.Checked {
							mark = "☑"
						} else {
							mark = "☐"
						}
					case "seen":
						mark = "👁"
						suffix = " (seen by " + strings.Join(ev.SeenBy, ", ") + ")"
					}
					ctx := ev.Section
					if ev.Thread != "" {
						ctx += " › " + ev.Thread
					}
					fmt.Printf("%s %s | %s | %s: %s%s\n", mark, ev.File, ctx, ev.Author, oneLine(ev.Text), suffix)
				}
			}
			st.hash = h
			st.items = items
		}
	}
}
