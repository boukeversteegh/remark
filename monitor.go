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
	Text       string   `json:"text"`
	Indent     int      `json:"indent"`
	Key        string   `json:"key"`
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
				Section: section, Indent: ind,
				Text: strings.TrimSpace(rest),
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
		stack = append(stack, it)
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
	Text    string   `json:"text"`
}

func monDiff(file string, oldItems, newItems []*monItem) []monEvent {
	old := map[string]*monItem{}
	for _, it := range oldItems {
		old[it.Key] = it
	}
	var evs []monEvent
	for _, it := range newItems {
		prev, existed := old[it.Key]
		if !existed {
			evs = append(evs, monEvent{Type: "comment", File: file, Author: it.Author,
				Time: it.Time, Checked: it.Checked, Section: it.Section, Thread: it.Thread, Root: it.Root, Parent: it.Parent, Text: it.Text})
			continue
		}
		if prev.Time == "now" && it.Time != "" && it.Time != "now" {
			// a "(now)" placeholder got its real stamp (window or remark stamp);
			// keyed on author+text, so only a placeholder-to-stamp change
			// counts — two comments sharing a key must not look like one
			evs = append(evs, monEvent{Type: "stamped", File: file, Author: it.Author,
				Time: it.Time, Checked: it.Checked, Section: it.Section, Thread: it.Thread, Root: it.Root, Parent: it.Parent, Text: it.Text})
		}
		if it.Resolvable && prev.Checked != it.Checked {
			evs = append(evs, monEvent{Type: "toggle", File: file, Author: it.Author,
				Time: it.Time, Checked: it.Checked, Section: it.Section, Thread: it.Thread, Root: it.Root, Parent: it.Parent, Text: it.Text})
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
						Section: it.Section, Thread: it.Thread, Root: it.Root, Parent: it.Parent, Text: it.Text})
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
				actor := ev.Author
				if ev.Type == "seen" && ev.Reader != "" {
					actor = ev.Reader
				}
				if ignored[monNormAuthor(actor)] {
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
					ctx := ev.Section
					if ev.Thread != "" {
						ctx += " › " + ev.Thread
					}
					outCh <- fmt.Sprintf("%s %s | %s | %s: %s%s", mark, ev.File, ctx, ev.Author, oneLine(ev.Text), suffix)
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
