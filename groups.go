package main

// Group sharing: the gateway's way to serve documents to OTHER people, not
// just the owner's own phone. A group is a named set of documents with its
// own key and QR; members scan the group's code, pick their own name on
// their phone (nothing synced from the owner's prefs) and see only the
// group's documents. The registry is a file the gateway re-reads on every
// request, like the docs registry, so a window's change takes effect at
// once and revoking one group's key never touches another.

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type groupMember struct {
	Name   string `json:"name"`
	Joined string `json:"joined"`
}

type gatewayGroup struct {
	ID      string        `json:"id"`
	Name    string        `json:"name"`
	Key     string        `json:"key"`
	Docs    []string      `json:"docs"`
	Members []groupMember `json:"members"`
}

func gatewayGroupsPath() string {
	return filepath.Join(filepath.Dir(prefsPath()), "gateway-groups.json")
}

func gatewayGroups() []gatewayGroup {
	var gs []gatewayGroup
	if b, err := os.ReadFile(gatewayGroupsPath()); err == nil {
		json.Unmarshal(b, &gs)
	}
	return gs
}

func gatewayWriteGroups(gs []gatewayGroup) {
	os.MkdirAll(filepath.Dir(gatewayGroupsPath()), 0o755)
	b, _ := json.MarshalIndent(gs, "", "  ")
	os.WriteFile(gatewayGroupsPath(), b, 0o644)
}

func groupRandHex(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func groupByID(id string) (gatewayGroup, bool) {
	for _, g := range gatewayGroups() {
		if g.ID == id {
			return g, true
		}
	}
	return gatewayGroup{}, false
}

// groupByToken resolves a composite "<id>.<key>" auth token to its group.
// The owner's pairing token never contains a dot, so the two cannot collide.
func groupByToken(t string) (gatewayGroup, bool) {
	id, key, ok := strings.Cut(t, ".")
	if !ok {
		return gatewayGroup{}, false
	}
	g, found := groupByID(id)
	if !found || key == "" || g.Key != key {
		return gatewayGroup{}, false
	}
	return g, true
}

func groupToken(g gatewayGroup) string { return g.ID + "." + g.Key }

func groupAllows(g gatewayGroup, p string) bool {
	if p == "" {
		return false
	}
	want := presenceNormPath(p)
	for _, d := range g.Docs {
		if presenceNormPath(d) == want {
			return true
		}
	}
	return false
}

// groupURL is what the group's QR encodes: a join link carrying the key.
func groupURL(rec gatewayRecord, g gatewayGroup) string {
	return fmt.Sprintf("http://%s:%d/g/%s?k=%s", gatewayHost(rec), rec.Port, g.ID, g.Key)
}

func groupNew(name string) gatewayGroup {
	g := gatewayGroup{ID: groupRandHex(4), Name: name, Key: groupRandHex(16), Docs: []string{}, Members: []groupMember{}}
	gatewayWriteGroups(append(gatewayGroups(), g))
	return g
}

// groupUpdate applies fn to the group with the given id and persists it.
func groupUpdate(id string, fn func(*gatewayGroup)) (gatewayGroup, bool) {
	gs := gatewayGroups()
	for i := range gs {
		if gs[i].ID == id {
			fn(&gs[i])
			gatewayWriteGroups(gs)
			return gs[i], true
		}
	}
	return gatewayGroup{}, false
}

func groupDelete(id string) bool {
	gs := gatewayGroups()
	out := gs[:0]
	for _, g := range gs {
		if g.ID != id {
			out = append(out, g)
		}
	}
	if len(out) == len(gs) {
		return false
	}
	gatewayWriteGroups(out)
	return true
}

func groupToggleDoc(id, p string, on bool) (gatewayGroup, bool) {
	abs, err := filepath.Abs(p)
	if err != nil {
		abs = p
	}
	return groupUpdate(id, func(g *gatewayGroup) {
		var docs []string
		for _, d := range g.Docs {
			if presenceNormPath(d) != presenceNormPath(abs) {
				docs = append(docs, d)
			}
		}
		if on {
			docs = append(docs, abs)
		}
		if docs == nil {
			docs = []string{}
		}
		g.Docs = docs
	})
}

// groupJoin registers a member name (idempotent on the exact name).
func groupJoin(id, name string) (gatewayGroup, bool) {
	name = strings.TrimSpace(name)
	if name == "" {
		return gatewayGroup{}, false
	}
	return groupUpdate(id, func(g *gatewayGroup) {
		for _, m := range g.Members {
			if m.Name == name {
				return
			}
		}
		g.Members = append(g.Members, groupMember{Name: name, Joined: time.Now().Format("2006-01-02 15:04")})
	})
}

func groupRemoveMember(id, name string) (gatewayGroup, bool) {
	return groupUpdate(id, func(g *gatewayGroup) {
		out := g.Members[:0]
		for _, m := range g.Members {
			if m.Name != name {
				out = append(out, m)
			}
		}
		g.Members = out
	})
}

// groupRotate issues a new key: every phone that scanned the old code is
// out until it scans the new one. Other groups and the owner's own pairing
// are untouched.
func groupRotate(id string) (gatewayGroup, bool) {
	return groupUpdate(id, func(g *gatewayGroup) { g.Key = groupRandHex(16) })
}

// groupMemberNames flattens members for the client.
func groupMemberNames(g gatewayGroup) []string {
	names := []string{}
	for _, m := range g.Members {
		names = append(names, m.Name)
	}
	return names
}

// groupJSON is the shape both panels consume. The join URL needs the
// gateway's live port, so it is only present while one is running — a
// stopped gateway would hand out a link nobody can use.
func groupJSON(rec gatewayRecord, alive bool, g gatewayGroup) map[string]any {
	docs := g.Docs
	if docs == nil {
		docs = []string{}
	}
	out := map[string]any{
		"id": g.ID, "name": g.Name, "docs": docs,
		"members": groupMemberNames(g),
	}
	if alive {
		out["url"] = groupURL(rec, g)
	}
	return out
}
