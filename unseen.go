package main

// remark unseen <files-or-globs...> -as <name>: every comment by someone
// else that does not carry <name> in its seen-marker — "what did I miss",
// including on files no monitor of mine was watching. One line per
// comment, in file order, with the stamp to reply to and the thread root.

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

func runUnseen(args []string) {
	var as string
	var pats []string
	for i := 0; i < len(args); i++ {
		a := args[i]
		if strings.TrimLeft(a, "-") == "as" && i+1 < len(args) {
			i++
			as = args[i]
			continue
		}
		if strings.HasPrefix(a, "-as=") {
			as = strings.TrimPrefix(a, "-as=")
			continue
		}
		pats = append(pats, a)
	}
	if as == "" || len(pats) == 0 {
		fmt.Fprintln(os.Stderr, "usage: remark unseen <files-or-globs...> -as <name>")
		os.Exit(2)
	}
	var files []string
	seen := map[string]bool{}
	for _, pat := range pats {
		matches, _ := filepath.Glob(pat)
		if matches == nil {
			matches = []string{pat}
		}
		for _, m := range matches {
			if abs, err := filepath.Abs(m); err == nil && !seen[abs] {
				seen[abs] = true
				files = append(files, abs)
			}
		}
	}
	total := 0
	for _, f := range files {
		b, err := os.ReadFile(f)
		if err != nil {
			fmt.Fprintf(os.Stderr, "remark unseen: %s: %v\n", f, err)
			continue
		}
		var hits []*monItem
		for _, it := range monParse(string(b)) {
			if it.Author == "" || monNormAuthor(it.Author) == monNormAuthor(as) {
				continue // unsigned items are not addressed to anyone yet
			}
			mine := false
			for _, n := range it.SeenBy {
				if monNormAuthor(n) == monNormAuthor(as) {
					mine = true
					break
				}
			}
			if !mine {
				hits = append(hits, it)
			}
		}
		if len(hits) == 0 {
			continue
		}
		fmt.Printf("%s — %d unseen\n", f, len(hits))
		for _, it := range hits {
			text := it.Text
			if it.Thread != "" && it.Indent == 0 {
				text = it.Thread
			}
			if len(text) > 72 {
				text = text[:72] + "…"
			}
			fmt.Printf("  %-19s  root %-19s  %-12s %s\n", it.Time, it.Root, it.Author, text)
		}
		total += len(hits)
	}
	if total == 0 {
		fmt.Printf("nothing unseen by %s in %d file(s)\n", as, len(files))
	}
}
