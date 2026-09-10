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
	"sync/atomic"
	"time"
	"unicode"
	"unicode/utf8"
)

// monNormAuthor: identity is the LITERAL author string (owner's decree) —
// no case folding, no emoji stripping. Trimming is parse hygiene only.
// `-as "🤖 Claude"` matches exactly the comments signed "🤖 Claude".
func monNormAuthor(s string) string {
	return strings.TrimSpace(s)
}

type monItem struct {
	Author     string   `json:"author"`
	Time       string   `json:"time,omitempty"`
	Checked    bool     `json:"checked"` // resolved; only meaningful when Resolvable
	Resolvable bool     `json:"resolvable"`
	SeenBy     []string `json:"seenBy,omitempty"`
	Section    string   `json:"section,omitempty"`
	Thread     string   `json:"thread,omitempty"`
	Root       string   `json:"root,omitempty"`   // timestamp of the thread root (its identity)
	Parent     string   `json:"parent,omitempty"` // timestamp of the comment this one answers ("" for a root)
	To         string   `json:"to,omitempty"`     // DM channels: the instance (sid) this comment is addressed to
	Text       string   `json:"text"`
	Indent     int      `json:"indent"`
	Key        string   `json:"key"`
	Tags       []string `json:"tags,omitempty"` // effective: written in the text plus reader tags (bare-tag replies)
	Bare       bool     `json:"bare,omitempty"` // a reply that is nothing but tags: tags its parent, not a comment
	body       string   // the full own text, for the tag scan (Text is capped)
}

// monListFlag collects a repeatable, comma-separable string flag.
type monListFlag []string

func (l *monListFlag) String() string { return strings.Join(*l, ",") }
func (l *monListFlag) Set(v string) error {
	for _, s := range strings.Split(v, ",") {
		if s = strings.TrimSpace(s); s != "" {
			*l = append(*l, s)
		}
	}
	return nil
}

// monToRe: a DM channel comment addressed to one instance carries
// <!--to:sid--> on its first line; other monitors of the same name stay
// silent on it (they can still read the file)
var monToRe = regexp.MustCompile(`<!--\s*to:\s*([^>]*?)\s*-->`)

// dmPath is the channel file for an author name: one per name under the
// config dir, so history is shared by every session using that name.
func dmPath(name string) string {
	d, err := os.UserConfigDir()
	if err != nil {
		d = "."
	}
	safe := strings.Map(func(r rune) rune {
		if strings.ContainsRune(`\/:*?"<>|`, r) {
			return '_'
		}
		return r
	}, strings.TrimSpace(name))
	return filepath.Join(d, "remark", "dm", safe+".md")
}

// dmEnsure creates the channel file with its chat marker if it is missing.
func dmEnsure(name string) string {
	p := dmPath(name)
	if _, err := os.Stat(p); err != nil {
		os.MkdirAll(filepath.Dir(p), 0o755)
		os.WriteFile(p, []byte("<!--remark:chat-->\n# "+strings.TrimSpace(name)+"\n\nDirect messages with "+strings.TrimSpace(name)+". Linear, no resolution; a reply quotes and links.\n"), 0o644)
	}
	return p
}

// monWritesLog is where remark reply/thread record what they wrote
// ("<abs file>|<stamp>" per line), so a monitor can tell a tool-written
// comment from a hand edit.
func monWritesLog() string {
	d, err := os.UserConfigDir()
	if err != nil {
		d = "."
	}
	return filepath.Join(d, "remark", "writes.log")
}

func monWrittenByTool(file, stamp string) bool {
	b, err := os.ReadFile(monWritesLog())
	if err != nil {
		return false
	}
	abs, _ := filepath.Abs(file)
	needle := strings.ToLower(abs) + "|" + stamp
	for _, l := range strings.Split(string(b), "\n") {
		if strings.TrimSpace(l) == needle {
			return true
		}
	}
	return false
}

// monMentions reports whether text tags name as "@name" — literal name,
// and the tag must end where the name ends, so "@Worker-3" does not fire
// for Worker-30. Names may contain spaces or emoji, hence no word regex.
func monMentions(text, name string) bool {
	if name == "" {
		return false
	}
	tag := "@" + name
	for i := 0; ; {
		j := strings.Index(text[i:], tag)
		if j < 0 {
			return false
		}
		end := i + j + len(tag)
		if end == len(text) {
			return true
		}
		r, _ := utf8.DecodeRuneInString(text[end:])
		if !unicode.IsLetter(r) && !unicode.IsDigit(r) {
			return true
		}
		i = end
	}
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
	// "(now)" is the placeholder a writer leaves when it does not want to
	// invent a stamp: recognised as a comment at once, replaced by a window
	// on the file or by `remark stamp`
	monTimeRe   = regexp.MustCompile(`\s*\((\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?|now)\)$`)
	monTitleRe  = regexp.MustCompile(`^\*\*([^*].*?)\*\*\s*$`)
	monSpaceRe  = regexp.MustCompile(`\s+`)
	monSymbolRe = regexp.MustCompile(`^[A-Za-z0-9]`)
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

// monNestedComment reports whether a NESTED checkbox line's text carries a
// comment signal: a thread/rv marker or an authored timestamp ((now)
// counts). Brackets alone are not enough — a task list pasted into a
// comment body must stay body content, or it would read as unauthored
// comments and get auto-stamped by a window.
func monNestedComment(text string) bool {
	stripped := monSeenRe.ReplaceAllString(text, "")
	if monMarkerRe.MatchString(stripped) {
		return true
	}
	_, ts, _, ok := monParseAuthor(monMarkerRe.ReplaceAllString(stripped, ""))
	return ok && ts != ""
}

// Catch-up state: with -as, the monitor persists its diff baseline per
// (identity, file) under the config dir. A restarted monitor loads its
// predecessor's baseline and the first tick replays every event the agent
// missed while it was down — no timestamps, no session ids, just the last
// state this identity actually reported.
type monSavedState struct {
	Hash  string     `json:"hash"`
	Items []*monItem `json:"items"`
}

func monStatePath(as, file string) string {
	h := sha256.Sum256([]byte(strings.TrimSpace(as) + "|" + presenceNormPath(file)))
	dir := filepath.Join(filepath.Dir(prefsPath()), "monitor-state")
	os.MkdirAll(dir, 0o755)
	return filepath.Join(dir, fmt.Sprintf("%x.json", h[:8]))
}

func monLoadState(as, file string) *monSavedState {
	b, err := os.ReadFile(monStatePath(as, file))
	if err != nil {
		return nil
	}
	var st monSavedState
	if json.Unmarshal(b, &st) != nil {
		return nil
	}
	return &st
}

func monSaveState(as, file, hash string, items []*monItem) {
	b, _ := json.Marshal(monSavedState{Hash: hash, Items: items})
	os.WriteFile(monStatePath(as, file), b, 0o644)
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
	content = strings.TrimPrefix(content, "\ufeff") // a BOM must not hide the first heading
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
			if ind > 0 && !monNestedComment(text) {
				isItem = false // a nested task-list checkbox, not a comment
			}
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
			to := ""
			if tm := monToRe.FindStringSubmatch(text); tm != nil {
				to = strings.TrimSpace(tm[1])
			}
			text = strings.TrimSpace(monToRe.ReplaceAllString(monSeenRe.ReplaceAllString(text, ""), ""))
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
				SeenBy: seenBy, To: to,
				Section: section, Indent: ind,
				Text: strings.TrimSpace(rest), body: strings.TrimSpace(rest),
			}
			if ind == 0 {
				threadLabel = ""
			}
			it.Thread = threadLabel
			it.Key = monNormalize(author + "|" + rest)
			items = append(items, it)
			last = it
			continue
		}
		// continuation line inside a thread
		if rootIndent >= 0 && last != nil && strings.TrimSpace(line) != "" && indent > last.Indent {
			cont := strings.TrimSpace(line)
			last.body += "\n" + cont
			if last.Indent == 0 && last.Text != "" && threadLabel == "" {
				if tm := monTitleRe.FindStringSubmatch(last.Text); tm != nil {
					threadLabel = tm[1]
					last.Thread = threadLabel
					last.Text = cont
					last.Key = monNormalize(last.Author + "|" + cont)
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
	// resolve thread labels: items inherit their root's title or author,
	// and carry the root's timestamp as the thread's identity
	var curLabel, curRoot string
	var stack []*monItem // ancestors by indent, for the parent stamp
	type monNeg struct {
		p    *monItem
		tags []string
	}
	var negs []monNeg
	for _, it := range items {
		if it.Indent == 0 {
			if it.Thread != "" {
				curLabel = it.Thread
			} else {
				curLabel = "thread by " + it.Author
			}
			curRoot = it.Time
			stack = stack[:0]
		}
		it.Thread = curLabel
		it.Root = curRoot
		for len(stack) > 0 && stack[len(stack)-1].Indent >= it.Indent {
			stack = stack[:len(stack)-1]
		}
		if len(stack) > 0 {
			it.Parent = stack[len(stack)-1].Time
		}
		// tags: a bare-tag reply tags its parent (and is keyed by that parent
		// too — "Bouke: #important" recurs under many comments); anything else
		// owns the tags in its own text. "-#tag" in a bare reply negates the
		// tag; negations are applied after the walk so they win regardless of
		// which reply sits first
		if it.Indent > 0 && tagIsBare(it.body) {
			it.Bare = true
			it.Key = monNormalize(it.Author + "|" + it.body + "|" + it.Parent)
			if len(stack) > 0 {
				p := stack[len(stack)-1]
				p.Tags = tagUnion(p.Tags, tagExtract(it.body))
				if n := tagExtractNeg(it.body); len(n) > 0 {
					negs = append(negs, monNeg{p, n})
				}
			}
		} else {
			it.Tags = tagUnion(tagExtract(it.body), it.Tags)
		}
		stack = append(stack, it)
	}
	for _, pn := range negs {
		pn.p.Tags = tagSubtract(pn.p.Tags, pn.tags)
	}
	return items
}

// monThreadScope decides which threads a scoped monitor reports: those
// whose root matches a -thread selector (timestamp, or the title verbatim)
// and, with -mine, those the agent took part in — a comment signed by it
// or one that tags it. Keyed by root timestamp; roots without one are keyed
// by their label so old files still scope.
func monThreadScope(items []*monItem, sels []string, mine bool, as string) map[string]bool {
	in := map[string]bool{}
	key := func(it *monItem) string {
		if it.Root != "" {
			return it.Root
		}
		return it.Thread
	}
	for _, it := range items {
		k := key(it)
		if in[k] {
			continue
		}
		if it.Indent == 0 {
			for _, sel := range sels {
				if readMatch(it.Time, sel) || strings.EqualFold(it.Thread, sel) {
					in[k] = true
				}
			}
		}
		if mine && as != "" && (it.Author == as || monMentions(it.Text, as) || (it.Indent == 0 && monMentions(it.Thread, as))) {
			in[k] = true
		}
	}
	return in
}

type monEvent struct {
	Type    string   `json:"type"` // comment | toggle | seen
	File    string   `json:"file"`
	Author  string   `json:"author"`
	Time    string   `json:"time,omitempty"`
	Checked bool     `json:"checked"`
	Reader  string   `json:"reader,omitempty"` // seen-events: who was added to the marker
	SeenBy  []string `json:"seenBy,omitempty"`
	Section string   `json:"section,omitempty"`
	Thread  string   `json:"thread,omitempty"`
	Root    string   `json:"root,omitempty"`   // thread root's timestamp: `remark read <file> <root>`
	Parent  string   `json:"parent,omitempty"` // the comment this one answers; "" for a root
	Dm      bool     `json:"dm,omitempty"`     // from the agent's own DM channel, not a document
	To      string   `json:"to,omitempty"`     // DM: the instance it was addressed to
	Text    string   `json:"text"`
	Tags    []string `json:"tags,omitempty"`    // the comment's current tag set
	Added   []string `json:"added,omitempty"`   // tag-events: what the actor put on
	Removed []string `json:"removed,omitempty"` // tag-events: what went away
	// on the FIRST comment a monitor delivers: how to acknowledge it. Agents
	// otherwise answer first and mark read afterwards, which leaves the human
	// looking at a comment nobody has picked up.
	Guidance string `json:"guidance,omitempty"`
}

// monGuidance is the one-time instruction that rides the first comment event.
func monGuidance(file, stamp, as string) string {
	who := as
	if who == "" {
		who = "<your name>"
	}
	// forward slashes and plain quotes: %q would escape the backslashes of a
	// Windows path into something no shell resolves the same way, and a
	// backslash path handed to a bash-ish shell is how a monitor once ended up
	// watching a file that did not exist
	return fmt.Sprintf(`Mark this read BEFORE you answer it: remark seen "%s" "%s" -as "%s" — `+
		"on receipt, so a long reply never leaves the comment looking unread. "+
		"Said once: it holds for every comment after this one.",
		filepath.ToSlash(file), stamp, who)
}

func monDiff(file string, oldItems, newItems []*monItem) []monEvent {
	old := map[string]*monItem{}
	for _, it := range oldItems {
		old[it.Key] = it
	}
	// new bare-tag replies, by the parent they tag: the ACTOR of a tag-event
	// is the tagger, so an agent's own tags never wake it
	taggers := map[string][]*monItem{}
	for _, it := range newItems {
		if it.Bare && old[it.Key] == nil {
			taggers[it.Parent] = append(taggers[it.Parent], it)
		}
	}
	// an edited comment keeps its stamp and changes its key: known by time
	oldByTime := map[string]*monItem{}
	for _, it := range oldItems {
		if !it.Bare && it.Time != "" && it.Time != "now" {
			oldByTime[it.Author+"|"+it.Time] = it
		}
	}
	var evs []monEvent
	for _, it := range newItems {
		if it.Bare {
			continue // never a comment; it surfaces as a tag-event on its parent
		}
		prev, existed := old[it.Key]
		if !existed {
			evs = append(evs, monEvent{Type: "comment", File: file, Author: it.Author,
				Time: it.Time, Checked: it.Checked, Section: it.Section, Thread: it.Thread, Root: it.Root, Parent: it.Parent, To: it.To, Text: it.Text, Tags: it.Tags})
			// an edit that changed the tags: say so, after the comment event
			if ed := oldByTime[it.Author+"|"+it.Time]; ed != nil && it.Time != "" && !monSameSet(ed.Tags, it.Tags) {
				evs = append(evs, monEvent{Type: "tag", File: file, Author: it.Author,
					Time: it.Time, Checked: it.Checked, Section: it.Section, Thread: it.Thread, Root: it.Root, Parent: it.Parent, To: it.To, Text: it.Text,
					Tags: it.Tags, Added: tagDiff(ed.Tags, it.Tags), Removed: tagDiff(it.Tags, ed.Tags)})
			}
			continue
		}
		if added, removed := tagDiff(prev.Tags, it.Tags), tagDiff(it.Tags, prev.Tags); len(added) > 0 || len(removed) > 0 {
			// one event per actor: each new bare-tag reply accounts for the
			// tags it carries — "#x" for additions, "-#x" for removals — and
			// the author for the rest (an edit of the text)
			byAdd := map[string][]string{}
			byRem := map[string][]string{}
			var order []string
			note := func(actor string) {
				if _, ok := byAdd[actor]; ok {
					return
				}
				if _, ok := byRem[actor]; ok {
					return
				}
				order = append(order, actor)
			}
			for _, t := range added {
				actor := it.Author
				for _, b := range taggers[it.Time] {
					if len(tagDiff(tagExtract(b.body), []string{t})) == 0 {
						actor = b.Author
						break
					}
				}
				note(actor)
				byAdd[actor] = append(byAdd[actor], t)
			}
			for _, t := range removed {
				actor := it.Author
				for _, b := range taggers[it.Time] {
					if len(tagDiff(tagExtractNeg(b.body), []string{t})) == 0 {
						actor = b.Author
						break
					}
				}
				note(actor)
				byRem[actor] = append(byRem[actor], t)
			}
			for _, actor := range order {
				evs = append(evs, monEvent{Type: "tag", File: file, Author: actor,
					Time: it.Time, Checked: it.Checked, Section: it.Section, Thread: it.Thread, Root: it.Root, Parent: it.Parent, To: it.To, Text: it.Text,
					Tags: it.Tags, Added: byAdd[actor], Removed: byRem[actor]})
			}
		}
		if prev.Time == "now" && it.Time != "" && it.Time != "now" {
			// a "(now)" placeholder got its real stamp (window or remark stamp);
			// keyed on author+text, so only a placeholder-to-stamp change
			// counts — two comments sharing a key must not look like one
			evs = append(evs, monEvent{Type: "stamped", File: file, Author: it.Author,
				Time: it.Time, Checked: it.Checked, Section: it.Section, Thread: it.Thread, Root: it.Root, Parent: it.Parent, To: it.To, Text: it.Text})
		}
		if it.Resolvable && prev.Checked != it.Checked {
			evs = append(evs, monEvent{Type: "toggle", File: file, Author: it.Author,
				Time: it.Time, Checked: it.Checked, Section: it.Section, Thread: it.Thread, Root: it.Root, Parent: it.Parent, To: it.To, Text: it.Text})
		}
		if !monSameSet(prev.SeenBy, it.SeenBy) {
			// the ACTOR of a seen-event is whoever was added to the marker,
			// not the comment's author — one event per added reader, so the
			// ignore filter judges the person who acted. Removals aren't
			// worth reporting.
			prevSet := map[string]bool{}
			for _, n := range prev.SeenBy {
				prevSet[n] = true
			}
			for _, n := range it.SeenBy {
				if !prevSet[n] {
					evs = append(evs, monEvent{Type: "seen", File: file, Author: it.Author,
						Reader: n, Time: it.Time, Checked: it.Checked, SeenBy: it.SeenBy,
						Section: it.Section, Thread: it.Thread, Root: it.Root, Parent: it.Parent, To: it.To, Text: it.Text})
				}
			}
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
	var threadSels monListFlag
	fs.Var(&threadSels, "thread", "only report threads whose root matches this selector (timestamp or exact title); repeatable or comma-separated")
	mine := fs.Bool("mine", false, "only report threads the -as agent took part in or was tagged in (@name)")

	// accept flags before or after the file arguments
	var flagArgs, fileArgs []string
	for i := 0; i < len(args); i++ {
		a := args[i]
		if strings.HasPrefix(a, "-") {
			flagArgs = append(flagArgs, a)
			needsValue := !strings.Contains(a, "=") &&
				(strings.Contains(a, "ignore-author") || strings.Contains(a, "interval") ||
					strings.TrimLeft(a, "-") == "as" || strings.TrimLeft(a, "-") == "thread")
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
	// an agent always watches its own DM channel too (created on first
	// use): one file per name, shared history, delivery addressed per instance
	dmFile := ""
	if *as != "" {
		dmFile = presenceNormPath(dmEnsure(*as))
		files = append(files, dmEnsure(*as))
	}
	if len(files) == 0 {
		fmt.Fprintln(os.Stderr, "remark monitor: no files matched")
		os.Exit(1)
	}
	// a watched path that does not exist produces no events, ever, and a
	// monitor on one is indistinguishable from a healthy quiet monitor —
	// refuse to start instead (the classic cause: a POSIX shell ate the
	// backslashes of a Windows path)
	missing := false
	for _, f := range files {
		if presenceNormPath(f) == dmFile {
			continue // the agent's own channel is created on first use
		}
		if _, err := os.Stat(f); err != nil {
			fmt.Fprintf(os.Stderr, "remark monitor: %s does not exist\n", f)
			missing = true
		}
	}
	if missing {
		fmt.Fprintln(os.Stderr, "create the file first, or fix the path (quote backslashes in POSIX shells, or use forward slashes)")
		os.Exit(1)
	}

	ignored := map[string]bool{}
	for _, n := range strings.Split(*ignore, ",") {
		if n = strings.TrimSpace(n); n != "" {
			ignored[monNormAuthor(n)] = true
		}
	}
	stampDelivered := func(string) {}
	if *as == "" && *ignore != "" {
		fmt.Fprintln(os.Stderr, "remark monitor: tip — use -as <yourname> instead of -ignore-author:")
		fmt.Fprintln(os.Stderr, "  it filters your own writes the same way AND announces your presence,")
		fmt.Fprintln(os.Stderr, "  so remark windows show you as online and get delivery receipts.")
	}
	if *as != "" {
		// identity: self-exclusion plus one presence heartbeat covering the
		// whole monitoring scope (patterns stay patterns — a glob monitor is
		// one participant, not one per matched file)
		ignored[monNormAuthor(*as)] = true
		stop := make(chan struct{})
		defer close(stop)
		stampDelivered = presenceAnnounce(*as, "agent", fileArgs, files, stop)
		// a name is identity for comments; an instance is a process. Two
		// live monitors with one name on one file are allowed (a restart
		// overlaps its predecessor for a moment) but never silent: say so
		// on the feed, the window shows the duplicate too
		if dups := presenceDuplicates(*as, files); len(dups) > 0 {
			for _, d := range dups {
				msg := fmt.Sprintf("another %q is already watching this scope (pid %d, since %s, in %s) — two agents with one name cannot be told apart in the file; pick a distinct -as unless this is a restart", *as, d.PID, d.Started, d.Cwd)
				fmt.Fprintln(os.Stderr, "remark monitor: "+msg)
				if *asJSON {
					j, _ := json.Marshal(map[string]any{"type": "warning", "text": msg, "pid": d.PID, "sid": d.Sid, "cwd": d.Cwd})
					fmt.Println(string(j))
				} else {
					fmt.Println("⚠ " + msg)
				}
			}
		}
	}

	// event lines go through a writer goroutine so a reader that stops
	// draining the pipe blocks only the writer; a watchdog then flips the
	// presence record to "stalled" — active pipe-drainage detection, so the
	// human sees "online (stalled)" instead of inferring it from missing
	// delivery checks
	outCh := make(chan string, 1024)
	var lastWrote int64 = time.Now().Unix()
	go func() {
		for line := range outCh {
			fmt.Println(line)
			atomic.StoreInt64(&lastWrote, time.Now().Unix())
		}
	}()
	go func() {
		stalled := false
		for range time.Tick(3 * time.Second) {
			blocked := len(outCh) > 0 && time.Now().Unix()-atomic.LoadInt64(&lastWrote) > 10
			if blocked != stalled {
				stalled = blocked
				presenceSetStalled(stalled)
			}
		}
	}()

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
			if *as != "" {
				// catch-up: start from the predecessor's baseline so the
				// first tick replays whatever this identity missed
				if saved := monLoadState(*as, f); saved != nil && saved.Hash != fmt.Sprintf("%x", st.hash) {
					fmt.Fprintf(os.Stderr, "remark monitor: %s changed while no monitor ran — replaying missed events\n", filepath.Base(f))
					st.items = saved.Items
					st.hash = [32]byte{} // force the first tick to diff
				} else {
					monSaveState(*as, f, fmt.Sprintf("%x", st.hash), st.items)
				}
			}
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

	// the first comment this monitor delivers carries the read-marker
	// instruction: an agent that answers a long question first and marks it
	// read afterwards leaves the human staring at an unanswered comment. Said
	// once per monitor — after that the agent knows.
	guided := false
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
			// torn-read guard: hand editors and scripts don't all write
			// atomically; if most known comments just "vanished", we probably
			// read mid-write — settle briefly and re-read before diffing,
			// or half the file gets re-emitted as new on the next tick
			if len(st.items) > 10 && len(items) < len(st.items)/2 {
				time.Sleep(150 * time.Millisecond)
				if b2, err := os.ReadFile(f); err == nil {
					b = b2
					h = sha256.Sum256(b)
					items = monParse(string(b))
				}
			}
			emitted := false
			// thread scope: with -thread/-mine only events inside the selected
			// threads pass, except a comment that tags the agent — a tag always
			// reaches its target, whatever the scope
			scoped := len(threadSels) > 0 || *mine
			var inScope map[string]bool
			if scoped {
				inScope = monThreadScope(items, threadSels, *mine, *as)
			}
			for _, ev := range monDiff(filepath.Base(f), st.items, items) {
				if dmFile != "" && presenceNormPath(f) == dmFile {
					ev.Dm = true
					// addressed to another instance of this name: not ours
					if ev.To != "" && ev.To != presenceOwnSid {
						continue
					}
				}
				actor := ev.Author
				if ev.Type == "seen" && ev.Reader != "" {
					actor = ev.Reader
				}
				if ignored[monNormAuthor(actor)] {
					// any own act (comment, seen-marker, toggle) is a sign of life
					// for the presence record: "active 2m ago" in the window
					if *as != "" && actor == *as {
						presenceSetActed(f)
					}
					// the agent's own hand-written comment: hand it back its real
					// stamp (once a "(now)" got filled) with the parent and root,
					// and the reply command that would have done it. Comments
					// written through remark reply/thread are on record and stay
					// silent, so this only ever fires for hand edits.
					if *as != "" && actor == *as && (ev.Type == "comment" || ev.Type == "stamped") &&
						ev.Time != "" && ev.Time != "now" && !monWrittenByTool(f, ev.Time) {
						target := ev.Parent
						if target == "" {
							target = ev.Root
						}
						hint := fmt.Sprintf("remark reply %s %s -as %q -text ...", filepath.Base(f), target, *as)
						if ev.Parent == "" {
							hint = fmt.Sprintf("remark thread %s -as %q -title ... -section ...", filepath.Base(f), *as)
						}
						if *asJSON {
							j, _ := json.Marshal(map[string]string{"type": "self", "file": ev.File, "time": ev.Time,
								"root": ev.Root, "parent": ev.Parent, "text": ev.Text, "hint": hint})
							outCh <- string(j)
						} else {
							outCh <- fmt.Sprintf("✍ %s | your hand-written comment is %s (parent %s, root %s) — next time: %s",
								ev.File, ev.Time, ev.Parent, ev.Root, hint)
						}
					}
					continue
				}
				if scoped {
					k := ev.Root
					if k == "" {
						k = ev.Thread
					}
					if !inScope[k] && !(ev.Type == "comment" && monMentions(ev.Text, *as)) {
						continue
					}
				}
				emitted = true
				if !guided && ev.Type == "comment" && ev.Time != "" {
					guided = true
					ev.Guidance = monGuidance(f, ev.Time, *as)
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
					case "stamped":
						mark = "🕒" // a (now) placeholder received its real stamp
					case "tag":
						mark = "🏷"
						var parts []string
						for _, t := range ev.Added {
							parts = append(parts, "+#"+t)
						}
						for _, t := range ev.Removed {
							parts = append(parts, "-#"+t)
						}
						suffix = " (" + strings.Join(parts, " ") + ")"
					case "seen":
						mark = "👁"
						// the added name says what HAPPENED; the full set only
						// says what the state is now
						if ev.Reader != "" {
							suffix = " (read by " + ev.Reader + ")"
						} else {
							suffix = " (seen by " + strings.Join(ev.SeenBy, ", ") + ")"
						}
					}
					if ev.Dm && ev.Type == "comment" {
						mark = "✉" // a direct message on this agent's channel
					}
					ctx := ev.Section
					if ev.Thread != "" {
						ctx += " › " + ev.Thread
					}
					outCh <- fmt.Sprintf("%s %s | %s | %s: %s%s", mark, ev.File, ctx, ev.Author, oneLine(ev.Text), suffix)
					if ev.Guidance != "" {
						outCh <- "↳ " + ev.Guidance
					}
				}
			}
			if emitted {
				// events left the monitor — the honest per-file delivery stamp
				stampDelivered(f)
			}
			st.hash = h
			st.items = items
			if *as != "" {
				monSaveState(*as, f, fmt.Sprintf("%x", h), items)
			}
		}
	}
}
