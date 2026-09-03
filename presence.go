package main

// Presence, modelled like pid files (design thread): a running participant —
// a remark window's local profile, or an agent running `remark monitor -as
// name` — writes ONE file with its details (name, pid, scope) under the
// shared config dir and removes it on clean exit. Liveness is not a
// heartbeat: readers check whether the recorded pid is still alive, so a
// crashed process reads as offline immediately and there is nothing to
// keep touching. The file carries the participant's monitoring SCOPE
// (patterns + expanded files); a window counts a participant as online when
// its own document falls inside that scope.

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

type presenceInfo struct {
	Name    string   `json:"name"`
	Kind    string   `json:"kind"` // "human" | "agent"
	PID     int      `json:"pid"`
	Started string   `json:"started"`
	Scope   []string `json:"scope,omitempty"` // glob patterns, normalized
	Files   []string `json:"files,omitempty"` // expanded at announce time, normalized
}

func presenceDir() string {
	return filepath.Join(filepath.Dir(prefsPath()), "presence")
}

// presenceNormPath makes document paths comparable across participants.
func presenceNormPath(p string) string {
	a, err := filepath.Abs(p)
	if err != nil {
		a = p
	}
	a = filepath.ToSlash(a)
	if runtime.GOOS == "windows" {
		a = strings.ToLower(a)
	}
	return a
}

func presenceMatches(info *presenceInfo, target string) bool {
	for _, f := range info.Files {
		if f == target {
			return true
		}
	}
	for _, pat := range info.Scope {
		if ok, _ := filepath.Match(pat, target); ok {
			return true
		}
	}
	return false
}

// presenceAnnounce drops this process's pid file, covering the given scope;
// when stop closes it is withdrawn. A glob monitor announces once, not per
// matched document.
func presenceAnnounce(name, kind string, patterns, files []string, stop <-chan struct{}) {
	if strings.TrimSpace(name) == "" {
		return
	}
	info := presenceInfo{Name: name, Kind: kind, PID: os.Getpid(),
		Started: time.Now().Format("2006-01-02 15:04")}
	for _, p := range patterns {
		info.Scope = append(info.Scope, presenceNormPath(p))
	}
	for _, f := range files {
		info.Files = append(info.Files, presenceNormPath(f))
	}
	h := sha256.Sum256([]byte(fmt.Sprintf("%s|%d|%s", strings.ToLower(name), os.Getpid(), strings.Join(info.Files, ","))))
	pf := filepath.Join(presenceDir(), hex.EncodeToString(h[:8])+".json")
	os.MkdirAll(presenceDir(), 0o755)
	b, _ := json.Marshal(info)
	os.WriteFile(pf, b, 0o644)
	go func() {
		<-stop
		os.Remove(pf)
	}()
}

type presenceEntry struct {
	Name     string `json:"name"`
	Kind     string `json:"kind"`
	Online   bool   `json:"online"`
	LastSeen string `json:"lastSeen"`
}

// presenceList returns everyone whose scope covers the given document,
// deduplicated by (normalized) name — an online sighting wins over a dead
// one. Files whose pid is gone are the trace of a dead process: reported
// offline (with when it started as "last seen") and cleaned up after a day.
func presenceList(file string) []presenceEntry {
	target := presenceNormPath(file)
	best := map[string]presenceEntry{}
	order := []string{}
	ents, err := os.ReadDir(presenceDir())
	if err != nil {
		return []presenceEntry{}
	}
	for _, e := range ents {
		p := filepath.Join(presenceDir(), e.Name())
		b, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		var info presenceInfo
		if json.Unmarshal(b, &info) != nil || !presenceMatches(&info, target) {
			continue
		}
		alive := pidAlive(info.PID)
		st, err := os.Stat(p)
		if err != nil {
			continue
		}
		if !alive && time.Since(st.ModTime()) > 24*time.Hour {
			os.Remove(p)
			continue
		}
		key := strings.ToLower(strings.TrimSpace(info.Name))
		entry := presenceEntry{Name: info.Name, Kind: info.Kind,
			Online: alive, LastSeen: info.Started}
		if prev, ok := best[key]; !ok {
			best[key] = entry
			order = append(order, key)
		} else if entry.Online && !prev.Online {
			best[key] = entry
		}
	}
	out := make([]presenceEntry, 0, len(order))
	for _, k := range order {
		out = append(out, best[k])
	}
	return out
}
