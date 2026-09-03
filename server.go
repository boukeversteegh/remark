package main

import (
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"
)

//go:embed ui
var uiFS embed.FS

// writeMu serializes our own writes per file path.
var writeMu sync.Map

func pathMutex(p string) *sync.Mutex {
	m, _ := writeMu.LoadOrStore(p, &sync.Mutex{})
	return m.(*sync.Mutex)
}

func hashBytes(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

func authed(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("t") != token {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		next(w, r)
	}
}

func jsonOut(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

type fileState struct {
	Content string `json:"content"`
	Hash    string `json:"hash"`
	Mtime   int64  `json:"mtime"`
}

func readState(path string) (*fileState, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	st, _ := os.Stat(path)
	var mt int64
	if st != nil {
		mt = st.ModTime().UnixMilli()
	}
	return &fileState{Content: string(b), Hash: hashBytes(b), Mtime: mt}, nil
}

func handleGetFile(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Query().Get("path")
	st, err := readState(p)
	if err != nil {
		jsonOut(w, http.StatusNotFound, map[string]string{"error": err.Error()})
		return
	}
	jsonOut(w, http.StatusOK, st)
}

type saveReq struct {
	Path     string `json:"path"`
	BaseHash string `json:"baseHash"`
	Content  string `json:"content"`
}

// handlePostFile is a compare-and-swap write: it only writes if the file on
// disk still matches baseHash; otherwise it returns 409 with the fresh
// content so the client can re-apply its pending operations and retry.
func handlePostFile(w http.ResponseWriter, r *http.Request) {
	var req saveReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonOut(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	mu := pathMutex(req.Path)
	mu.Lock()
	defer mu.Unlock()

	cur, err := readState(req.Path)
	if err != nil {
		jsonOut(w, http.StatusNotFound, map[string]string{"error": err.Error()})
		return
	}
	if cur.Hash != req.BaseHash {
		jsonOut(w, http.StatusConflict, cur)
		return
	}

	dir := filepath.Dir(req.Path)
	tmp, err := os.CreateTemp(dir, ".remark-tmp-*")
	if err != nil {
		jsonOut(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	tmpName := tmp.Name()
	_, werr := tmp.WriteString(req.Content)
	cerr := tmp.Close()
	if werr != nil || cerr != nil {
		os.Remove(tmpName)
		jsonOut(w, http.StatusInternalServerError, map[string]string{"error": "write failed"})
		return
	}
	if st, err := os.Stat(req.Path); err == nil {
		os.Chmod(tmpName, st.Mode())
	}
	if err := os.Rename(tmpName, req.Path); err != nil {
		os.Remove(tmpName)
		jsonOut(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	jsonOut(w, http.StatusOK, map[string]string{"hash": hashBytes([]byte(req.Content))})
}

// handleEvents streams file changes over SSE. Each connection polls the
// file's mtime/size cheaply and pushes full content when the hash changes.
func handleEvents(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Query().Get("path")
	fl, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	// an open watcher means a human is looking at this file — announce the
	// local profile for the presence panel while the stream lives
	var me string
	if prefsGetKey("me", &me) && me != "" {
		stop := make(chan struct{})
		defer close(stop)
		presenceAnnounce(me, "human", nil, []string{p}, stop)
	}

	var lastHash string
	var lastMtime int64
	var lastSize int64
	if st, err := os.Stat(p); err == nil {
		lastMtime = st.ModTime().UnixMilli()
		lastSize = st.Size()
		if b, err := os.ReadFile(p); err == nil {
			lastHash = hashBytes(b)
		}
	}

	ticker := time.NewTicker(250 * time.Millisecond)
	defer ticker.Stop()
	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case <-heartbeat.C:
			fmt.Fprint(w, ": ping\n\n")
			fl.Flush()
		case <-ticker.C:
			st, err := os.Stat(p)
			if err != nil {
				continue
			}
			mt, sz := st.ModTime().UnixMilli(), st.Size()
			if mt == lastMtime && sz == lastSize {
				continue
			}
			lastMtime, lastSize = mt, sz
			state, err := readState(p)
			if err != nil || state.Hash == lastHash {
				continue
			}
			lastHash = state.Hash
			b, _ := json.Marshal(state)
			fmt.Fprintf(w, "data: %s\n\n", b)
			fl.Flush()
		}
	}
}

// prefs: a small JSON blob under the OS config dir, shared by all remark
// instances (one process per open file/window). POST merges top-level keys;
// a null value deletes a key.
var prefsMu sync.Mutex

func prefsPath() string {
	d, err := os.UserConfigDir()
	if err != nil {
		d = "."
	}
	return filepath.Join(d, "remark", "prefs.json")
}

// prefsGetKey / prefsSetKey give in-process code (e.g. window-bounds
// tracking) access to the same merged prefs store the client uses.
func prefsGetKey(key string, out any) bool {
	prefsMu.Lock()
	defer prefsMu.Unlock()
	b, err := os.ReadFile(prefsPath())
	if err != nil {
		return false
	}
	cur := map[string]json.RawMessage{}
	if json.Unmarshal(b, &cur) != nil {
		return false
	}
	raw, ok := cur[key]
	return ok && json.Unmarshal(raw, out) == nil
}

func prefsSetKey(key string, v any) {
	prefsMu.Lock()
	defer prefsMu.Unlock()
	cur := map[string]json.RawMessage{}
	if b, err := os.ReadFile(prefsPath()); err == nil {
		json.Unmarshal(b, &cur)
	}
	raw, err := json.Marshal(v)
	if err != nil {
		return
	}
	cur[key] = raw
	os.MkdirAll(filepath.Dir(prefsPath()), 0o755)
	b, _ := json.Marshal(cur)
	os.WriteFile(prefsPath(), b, 0o644)
}

func handleGetPrefs(w http.ResponseWriter, r *http.Request) {
	prefsMu.Lock()
	defer prefsMu.Unlock()
	b, err := os.ReadFile(prefsPath())
	if err != nil {
		b = []byte("{}")
	}
	w.Header().Set("Content-Type", "application/json")
	w.Write(b)
}

func handlePostPrefs(w http.ResponseWriter, r *http.Request) {
	var patch map[string]json.RawMessage
	if err := json.NewDecoder(r.Body).Decode(&patch); err != nil {
		jsonOut(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	prefsMu.Lock()
	defer prefsMu.Unlock()
	cur := map[string]json.RawMessage{}
	if b, err := os.ReadFile(prefsPath()); err == nil {
		json.Unmarshal(b, &cur)
	}
	for k, v := range patch {
		if string(v) == "null" {
			delete(cur, k)
		} else {
			cur[k] = v
		}
	}
	os.MkdirAll(filepath.Dir(prefsPath()), 0o755)
	b, _ := json.Marshal(cur)
	if err := os.WriteFile(prefsPath(), b, 0o644); err != nil {
		jsonOut(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	jsonOut(w, http.StatusOK, map[string]bool{"ok": true})
}

func newMux() *http.ServeMux {
	mux := http.NewServeMux()
	sub, _ := fs.Sub(uiFS, "ui")
	fileServer := http.FileServer(http.FS(sub))

	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" {
			if r.URL.Query().Get("t") != token {
				http.Error(w, "forbidden", http.StatusForbidden)
				return
			}
			b, _ := fs.ReadFile(sub, "index.html")
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Write(b)
			return
		}
		fileServer.ServeHTTP(w, r)
	})
	mux.HandleFunc("GET /api/file", authed(handleGetFile))
	mux.HandleFunc("POST /api/file", authed(handlePostFile))
	mux.HandleFunc("GET /api/events", authed(handleEvents))
	mux.HandleFunc("GET /api/pickfile", authed(func(w http.ResponseWriter, r *http.Request) {
		jsonOut(w, http.StatusOK, map[string]string{"path": pickFile(r.URL.Query().Get("dir"))})
	}))
	mux.HandleFunc("GET /api/prefs", authed(handleGetPrefs))
	mux.HandleFunc("POST /api/prefs", authed(handlePostPrefs))
	mux.HandleFunc("GET /api/presence", authed(func(w http.ResponseWriter, r *http.Request) {
		jsonOut(w, http.StatusOK, presenceList(r.URL.Query().Get("path")))
	}))
	return mux
}
