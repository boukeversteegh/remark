package main

import (
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
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
		_ = presenceAnnounce(me, "human", nil, []string{p}, stop)
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

var imageNameRe = regexp.MustCompile(`[^A-Za-z0-9._-]+`)

// handlePostImage stores pasted image bytes next to the document and returns
// the relative filename to embed. Query: path (the md file), name (optional
// clipboard filename), ext (fallback extension from the MIME type).
func handlePostImage(w http.ResponseWriter, r *http.Request) {
	docPath := r.URL.Query().Get("path")
	if docPath == "" {
		jsonOut(w, http.StatusBadRequest, map[string]string{"error": "path required"})
		return
	}
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 32<<20))
	if err != nil || len(data) == 0 {
		jsonOut(w, http.StatusBadRequest, map[string]string{"error": "no image data"})
		return
	}
	ext := r.URL.Query().Get("ext")
	if ext == "" {
		ext = "png"
	}
	name := imageNameRe.ReplaceAllString(r.URL.Query().Get("name"), "-")
	// generic clipboard names carry no information — synthesize from the doc
	if name == "" || name == "image.png" || name == "image" {
		stem := strings.TrimSuffix(filepath.Base(docPath), filepath.Ext(docPath))
		name = stem + "-" + time.Now().Format("20060102-150405") + "." + ext
	} else if filepath.Ext(name) == "" {
		name += "." + ext
	}
	dir := filepath.Dir(docPath)
	final := name
	stem := strings.TrimSuffix(name, filepath.Ext(name))
	for i := 2; ; i++ {
		if _, err := os.Stat(filepath.Join(dir, final)); os.IsNotExist(err) {
			break
		}
		final = fmt.Sprintf("%s-%d%s", stem, i, filepath.Ext(name))
	}
	if err := os.WriteFile(filepath.Join(dir, final), data, 0o644); err != nil {
		jsonOut(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	jsonOut(w, http.StatusOK, map[string]string{"file": final})
}

// uiReady closes once the frontend reports its first paint — the window
// stays hidden behind the splash until then.
var uiReady = make(chan struct{})
var uiReadyOnce sync.Once

// prefs: a small JSON blob under the OS config dir, shared by all remark
// instances (one process per open file/window). POST merges top-level keys;
// a null value deletes a key.
var prefsMu sync.Mutex

// selfStamp is the size and mtime of this process's binary as it was at
// start; selfUpdated compares the file now at that path against it
var selfStamp = func() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	st, err := os.Stat(exe)
	if err != nil {
		return ""
	}
	return fmt.Sprintf("%d|%d", st.Size(), st.ModTime().UnixNano())
}()

// selfCurrentStamp is the size|mtime of whatever binary sits at this
// process's path right now ("" when unknown).
func selfCurrentStamp() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	st, err := os.Stat(exe)
	if err != nil {
		return ""
	}
	return fmt.Sprintf("%d|%d", st.Size(), st.ModTime().UnixNano())
}

func selfUpdated() bool {
	cur := selfCurrentStamp()
	return selfStamp != "" && cur != "" && cur != selfStamp
}

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
	mux.HandleFunc("GET /api/uiready", authed(func(w http.ResponseWriter, r *http.Request) {
		uiReadyOnce.Do(func() { close(uiReady) })
		jsonOut(w, http.StatusOK, map[string]bool{"ok": true})
	}))
	mux.HandleFunc("GET /api/presence", authed(func(w http.ResponseWriter, r *http.Request) {
		jsonOut(w, http.StatusOK, presenceList(r.URL.Query().Get("path")))
	}))
	// self-update awareness: `remark install` moves the running binary aside
	// and puts the new one at the same path, so a running instance can tell
	// a newer build arrived by watching its own path; the UI offers a restart
	mux.HandleFunc("GET /api/update", authed(func(w http.ResponseWriter, r *http.Request) {
		// "stamp" identifies the build now at the path, so the UI can notify
		// once per distinct update — a dismissal covers that build only
		jsonOut(w, http.StatusOK, map[string]any{"updated": selfUpdated(), "stamp": selfCurrentStamp()})
	}))
	mux.HandleFunc("POST /api/restart", authed(func(w http.ResponseWriter, r *http.Request) {
		exe, err := os.Executable()
		if err != nil {
			jsonOut(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		args := []string{}
		if p := r.URL.Query().Get("path"); p != "" {
			args = append(args, p)
		}
		if err := exec.Command(exe, args...).Start(); err != nil {
			jsonOut(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		jsonOut(w, http.StatusOK, map[string]bool{"ok": true})
		go func() { time.Sleep(400 * time.Millisecond); os.Exit(0) }()
	}))
	// pasted images: bytes in, a filename next to the document out. The name
	// comes from the clipboard when it has a real one, else <mdname>-<stamp>;
	// collisions get -2, -3, …
	mux.HandleFunc("POST /api/image", authed(handlePostImage))
	// serve files relative to a document's folder (images referenced by the
	// markdown). Parent paths ("../shared/x.png") resolve the way markdown
	// means them; absolute paths, UNC paths and anything but a regular file
	// are refused, and the token keeps this private to the local window
	mux.HandleFunc("GET /api/asset", authed(func(w http.ResponseWriter, r *http.Request) {
		docDir := filepath.Dir(r.URL.Query().Get("path"))
		rel := filepath.FromSlash(r.URL.Query().Get("f"))
		if rel == "" || filepath.IsAbs(rel) || strings.HasPrefix(rel, `\\`) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		target := filepath.Join(docDir, rel)
		if st, err := os.Stat(target); err != nil || !st.Mode().IsRegular() {
			http.NotFound(w, r)
			return
		}
		http.ServeFile(w, r, target)
	}))
	// links in the rendered document open in the system browser, not the
	// app window; schemes are whitelisted so this can't be used to run things
	mux.HandleFunc("GET /api/openurl", authed(func(w http.ResponseWriter, r *http.Request) {
		u := r.URL.Query().Get("u")
		if strings.HasPrefix(u, "http://") || strings.HasPrefix(u, "https://") || strings.HasPrefix(u, "mailto:") {
			openBrowser(u)
			jsonOut(w, http.StatusOK, map[string]bool{"ok": true})
			return
		}
		jsonOut(w, http.StatusBadRequest, map[string]string{"error": "unsupported scheme"})
	}))
	// a relative link in the document, resolved against the document's
	// folder: markdown opens in a second remark window (exactly what
	// `remark other.md` does), any other existing file in its default app.
	// Only existing regular files qualify, so this cannot run anything.
	mux.HandleFunc("GET /api/openfile", authed(func(w http.ResponseWriter, r *http.Request) {
		doc := r.URL.Query().Get("path")
		href := r.URL.Query().Get("href")
		if i := strings.IndexAny(href, "#?"); i >= 0 {
			href = href[:i]
		}
		if u, err := url.PathUnescape(href); err == nil {
			href = u
		}
		if doc == "" || href == "" {
			jsonOut(w, http.StatusBadRequest, map[string]string{"error": "missing path or href"})
			return
		}
		target := filepath.FromSlash(href)
		if !filepath.IsAbs(target) {
			target = filepath.Join(filepath.Dir(doc), target)
		}
		if st, err := os.Stat(target); err != nil || !st.Mode().IsRegular() {
			jsonOut(w, http.StatusNotFound, map[string]string{"error": "no such file: " + target})
			return
		}
		switch strings.ToLower(filepath.Ext(target)) {
		case ".md", ".markdown", ".mdown", ".mkd", ".txt":
			exe, err := os.Executable()
			if err == nil {
				err = exec.Command(exe, target).Start()
			}
			if err != nil {
				jsonOut(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
				return
			}
			jsonOut(w, http.StatusOK, map[string]any{"ok": true, "remark": true, "path": target})
		default:
			openBrowser(target)
			jsonOut(w, http.StatusOK, map[string]any{"ok": true, "remark": false, "path": target})
		}
	}))
	return mux
}
