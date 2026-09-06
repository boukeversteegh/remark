package main

// remark gateway: the phone's way in. One long-running process, separate
// from any window, that serves the same UI over the network to a paired
// phone, restricted to the documents a window put "on the phone". It is
// tracked by a record in the config dir (pid, port, token) so any window
// can start, stop and inspect it; the registry of documents is a second
// file the gateway re-reads on every request, so a window's toggle takes
// effect at once. Edits from the phone go through the same compare-and-swap
// file API a window uses, so concurrency needs no authority: the file is
// the truth, agents keep editing it directly.
//
//	remark gateway            run it (foreground; a window starts it detached)
//	remark gateway status     print the record and the registry
//	remark gateway stop       stop the running one
//	remark gateway add <f>    put a document on the phone
//	remark gateway remove <f> take it off again
//	remark gateway qr         print the pairing URL (the window shows a QR)

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	qrcode "github.com/skip2/go-qrcode"
)

type gatewayRecord struct {
	PID     int    `json:"pid"`
	Port    int    `json:"port"`
	Token   string `json:"token"`
	Started string `json:"started"`
	Host    string `json:"host,omitempty"` // pinned by `remark gateway host`; else detected
}

func gatewayRecordPath() string { return filepath.Join(filepath.Dir(prefsPath()), "gateway.json") }
func gatewayDocsPath() string   { return filepath.Join(filepath.Dir(prefsPath()), "gateway-docs.json") }

var gatewayMode bool // this process IS the gateway: restrict paths, no process spawning

func gatewayReadRecord() (gatewayRecord, bool) {
	var rec gatewayRecord
	b, err := os.ReadFile(gatewayRecordPath())
	if err != nil || json.Unmarshal(b, &rec) != nil {
		return rec, false
	}
	return rec, rec.PID > 0 && pidAlive(rec.PID)
}

// gatewayClearPID marks the gateway stopped but keeps the record, above
// all the token: stop/start must not force every phone to pair again.
func gatewayClearPID(rec gatewayRecord) {
	rec.PID = 0
	out, _ := json.MarshalIndent(rec, "", "  ")
	os.WriteFile(gatewayRecordPath(), out, 0o644)
}

func gatewayDocs() []string {
	var docs []string
	if b, err := os.ReadFile(gatewayDocsPath()); err == nil {
		json.Unmarshal(b, &docs)
	}
	return docs
}

func gatewayWriteDocs(docs []string) {
	os.MkdirAll(filepath.Dir(gatewayDocsPath()), 0o755)
	b, _ := json.MarshalIndent(docs, "", "  ")
	os.WriteFile(gatewayDocsPath(), b, 0o644)
}

// gatewayAllows reports whether a document path is registered.
func gatewayAllows(p string) bool {
	if p == "" {
		return false
	}
	want := presenceNormPath(p)
	for _, d := range gatewayDocs() {
		if presenceNormPath(d) == want {
			return true
		}
	}
	return false
}

func gatewayToggle(p string, on bool) []string {
	abs, err := filepath.Abs(p)
	if err != nil {
		abs = p
	}
	var out []string
	for _, d := range gatewayDocs() {
		if presenceNormPath(d) != presenceNormPath(abs) {
			out = append(out, d)
		}
	}
	if on {
		out = append(out, abs)
	}
	gatewayWriteDocs(out)
	return out
}

// gatewayLANAddrs lists this machine's non-loopback IPv4 addresses, private
// ranges first — what a phone on the same network or VPN can reach.
func gatewayLANAddrs() []string {
	// rank: home LAN (192.168, 10.) and VPN overlays (100.64/10) before the
	// 172.16/12 block that Docker and WSL adapters usually occupy, then the rest
	rank := func(ip net.IP) int {
		switch {
		case ip[0] == 192 && ip[1] == 168:
			return 0
		case ip[0] == 10:
			return 1
		case ip[0] == 100 && ip[1] >= 64 && ip[1] < 128:
			return 2
		case ip[0] == 172 && ip[1] >= 16 && ip[1] < 32:
			return 3
		default:
			return 4
		}
	}
	buckets := make([][]string, 5)
	ifs, _ := net.Interfaces()
	for _, i := range ifs {
		if i.Flags&net.FlagUp == 0 || i.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, _ := i.Addrs()
		for _, a := range addrs {
			ipn, ok := a.(*net.IPNet)
			if !ok || ipn.IP.To4() == nil {
				continue
			}
			ip := ipn.IP.To4()
			buckets[rank(ip)] = append(buckets[rank(ip)], ip.String())
		}
	}
	var out []string
	for _, b := range buckets {
		out = append(out, b...)
	}
	return out
}

// gatewayHost is the name the pairing code carries: a pinned one, else the
// name the network gives this machine's address (reverse lookup — a home
// router answers with "<pc>.home"), else machine name + the DNS suffix
// the OS knows; each candidate is used only if it resolves back to one of
// this machine's addresses, otherwise the bare IP.
func gatewayHost(rec gatewayRecord) string {
	addrs := gatewayLANAddrs()
	ip := "127.0.0.1"
	if len(addrs) > 0 {
		ip = addrs[0]
	}
	mine := map[string]bool{}
	for _, a := range addrs {
		mine[a] = true
	}
	resolves := func(name string) bool {
		name = strings.TrimSuffix(strings.TrimSpace(name), ".")
		if name == "" {
			return false
		}
		got, err := net.LookupHost(name)
		if err != nil {
			return false
		}
		for _, g := range got {
			if mine[g] {
				return true
			}
		}
		return false
	}
	if rec.Host != "" {
		return rec.Host // pinned by hand: trusted as is
	}
	if names, err := net.LookupAddr(ip); err == nil {
		for _, n := range names {
			if n = strings.ToLower(strings.TrimSuffix(n, ".")); resolves(n) {
				return n
			}
		}
	}
	if hn, err := os.Hostname(); err == nil && hn != "" {
		hn = strings.ToLower(hn)
		for _, suffix := range osDNSSuffixes() {
			if cand := hn + "." + strings.ToLower(suffix); resolves(cand) {
				return cand
			}
		}
		if resolves(hn) {
			return hn
		}
	}
	return ip
}

func gatewayURL(rec gatewayRecord) string {
	return fmt.Sprintf("http://%s:%d/?t=%s", gatewayHost(rec), rec.Port, rec.Token)
}

// gatewayHandler wraps the normal mux: every document path in a request
// must be registered, and endpoints that spawn or end processes on the PC
// are off — the phone reads and writes documents, nothing more.
func gatewayHandler(mux http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/openfile", "/api/openurl", "/api/dm", "/api/restart", "/api/gateway/start", "/api/gateway/stop":
			http.Error(w, "not available through the gateway", http.StatusForbidden)
			return
		}
		q := r.URL.Query()
		for _, k := range []string{"path", "f"} {
			if p := q.Get(k); p != "" && !gatewayAllows(p) {
				http.Error(w, "this document is not shared with the phone", http.StatusForbidden)
				return
			}
		}
		if r.Method == "POST" && r.URL.Path == "/api/file" {
			// the body names the path; the handler re-checks nothing, so peek
			var body struct {
				Path string `json:"path"`
			}
			b, _ := readBodyPeek(r)
			json.Unmarshal(b, &body)
			if !gatewayAllows(body.Path) {
				http.Error(w, "this document is not shared with the phone", http.StatusForbidden)
				return
			}
		}
		mux.ServeHTTP(w, r)
	})
}

func runGateway(args []string) {
	sub := ""
	if len(args) > 0 {
		sub = args[0]
	}
	switch sub {
	case "status":
		rec, alive := gatewayReadRecord()
		if alive {
			fmt.Printf("running: pid %d, port %d, since %s\n%s\n", rec.PID, rec.Port, rec.Started, gatewayURL(rec))
		} else {
			fmt.Println("not running")
		}
		for _, d := range gatewayDocs() {
			fmt.Println("  on the phone:", d)
		}
		return
	case "stop":
		rec, alive := gatewayReadRecord()
		if !alive {
			fmt.Println("not running")
			return
		}
		if p, err := os.FindProcess(rec.PID); err == nil {
			p.Kill()
		}
		gatewayClearPID(rec)
		fmt.Println("stopped; the pairing code is kept, start again and the phone just refreshes")
		return
	case "add", "remove":
		if len(args) < 2 {
			fmt.Fprintln(os.Stderr, "usage: remark gateway", sub, "<file>")
			os.Exit(2)
		}
		docs := gatewayToggle(args[1], sub == "add")
		fmt.Printf("%d document(s) on the phone\n", len(docs))
		return
	case "qr":
		rec, alive := gatewayReadRecord()
		if !alive {
			fmt.Println("not running")
			os.Exit(1)
		}
		fmt.Println(gatewayURL(rec))
		return
	case "rotate":
		rec, err := gatewayRotate()
		if err != nil {
			fmt.Fprintln(os.Stderr, "remark gateway rotate:", err)
			os.Exit(1)
		}
		fmt.Println("new code issued; paired phones must scan again:", gatewayURL(rec))
		return
	case "host":
		// pin (or with "-" clear) the name the pairing code carries
		rec, _ := gatewayReadRecord()
		if len(args) < 2 {
			fmt.Println("host:", gatewayHost(rec), "(detected)")
			return
		}
		if args[1] == "-" {
			rec.Host = ""
		} else {
			rec.Host = args[1]
		}
		os.MkdirAll(filepath.Dir(gatewayRecordPath()), 0o755)
		out, _ := json.MarshalIndent(rec, "", "  ")
		os.WriteFile(gatewayRecordPath(), out, 0o644)
		fmt.Println("pairing code now uses", gatewayHost(rec))
		return
	case "", "run":
	default:
		fmt.Fprintln(os.Stderr, "usage: remark gateway [run|status|stop|add <file>|remove <file>|qr]")
		os.Exit(2)
	}

	if rec, alive := gatewayReadRecord(); alive {
		fmt.Printf("remark gateway: already running (pid %d, port %d)\n", rec.PID, rec.Port)
		return
	}
	// the token is long-lived: pairing happens once, the phone keeps it
	rec := gatewayRecord{PID: os.Getpid(), Port: 7444, Started: time.Now().Format("2006-01-02 15:04")}
	if old, _ := gatewayReadRecord(); old.Token != "" {
		rec.Token = old.Token
	} else {
		b := make([]byte, 16)
		rand.Read(b)
		rec.Token = hex.EncodeToString(b)
	}
	if v := os.Getenv("REMARK_GATEWAY_PORT"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			rec.Port = n
		}
	}
	var ln net.Listener
	var err error
	for i := 0; i < 20; i++ {
		ln, err = net.Listen("tcp", fmt.Sprintf("0.0.0.0:%d", rec.Port))
		if err == nil {
			break
		}
		rec.Port++
	}
	if ln == nil {
		fmt.Fprintln(os.Stderr, "remark gateway: could not bind a port:", err)
		os.Exit(1)
	}
	token = rec.Token
	gatewayMode = true
	os.MkdirAll(filepath.Dir(gatewayRecordPath()), 0o755)
	b, _ := json.MarshalIndent(rec, "", "  ")
	os.WriteFile(gatewayRecordPath(), b, 0o644)
	if _, err := os.Stat(gatewayDocsPath()); err != nil {
		gatewayWriteDocs([]string{})
	}
	fmt.Println("remark gateway listening on", gatewayURL(rec))
	fmt.Println("pair a phone with the QR in any window's Gateway panel, or open that URL on it")
	if err := http.Serve(ln, gatewayHandler(newMux())); err != nil {
		fmt.Fprintln(os.Stderr, "remark gateway: server stopped:", err)
	}
	os.Remove(gatewayRecordPath())
}

// readBodyPeek reads a request body and puts it back for the real handler.
func readBodyPeek(r *http.Request) ([]byte, error) {
	b, err := io.ReadAll(r.Body)
	if err != nil {
		return nil, err
	}
	r.Body = io.NopCloser(bytes.NewReader(b))
	return b, nil
}

// startDetached runs the binary as its own process that outlives this one.
func startDetached(exe string, args ...string) error {
	return exec.Command(exe, args...).Start()
}

// gatewayRotate replaces the token: every paired phone drops off until it
// scans the new code. A running gateway restarts to pick it up.
func gatewayRotate() (gatewayRecord, error) {
	rec, alive := gatewayReadRecord()
	b := make([]byte, 16)
	rand.Read(b)
	rec.Token = hex.EncodeToString(b)
	if alive {
		if p, err := os.FindProcess(rec.PID); err == nil {
			p.Kill()
		}
	}
	rec.PID = 0
	os.MkdirAll(filepath.Dir(gatewayRecordPath()), 0o755)
	out, _ := json.MarshalIndent(rec, "", "  ")
	if err := os.WriteFile(gatewayRecordPath(), out, 0o644); err != nil {
		return rec, err
	}
	if alive {
		time.Sleep(300 * time.Millisecond)
		return rec, gatewayStartDetached()
	}
	return rec, nil
}

// gatewayQRPNG renders the pairing URL as a PNG.
func gatewayQRPNG(rec gatewayRecord) ([]byte, error) {
	return qrcode.Encode(gatewayURL(rec), qrcode.Medium, 320)
}

// gatewayStartDetached spawns `remark gateway` as its own process.
func gatewayStartDetached() error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	return startDetached(exe, "gateway")
}

func gatewayStatusJSON(doc string) map[string]any {
	rec, alive := gatewayReadRecord()
	docs := gatewayDocs()
	if docs == nil {
		docs = []string{}
	}
	out := map[string]any{"running": alive, "docs": docs, "addrs": gatewayLANAddrs()}
	if alive {
		out["port"] = rec.Port
		out["since"] = rec.Started
		out["url"] = gatewayURL(rec)
		out["host"] = gatewayHost(rec)
		out["hostPinned"] = rec.Host != ""
	}
	if doc != "" {
		out["shared"] = gatewayAllows(doc)
	}
	if out["docs"] == nil {
		out["docs"] = []string{}
	}
	return out
}
