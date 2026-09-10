package main

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// The pairing URL must carry a name other machines can resolve. Docker
// Desktop parks "host.docker.internal" on the real LAN address, so a reverse
// lookup offers it and it even resolves back to us — yet no phone can reach
// it, which is exactly how sharing looked broken on the LAN.
func TestGatewayVirtualName(t *testing.T) {
	for _, n := range []string{
		"host.docker.internal", "HOST.DOCKER.INTERNAL", "gateway.docker.internal",
		"localhost", "", "bouke-hp.mshome.net", "somehost.wsl", "vmware-host",
	} {
		if !gatewayVirtualName(n) {
			t.Errorf("%q should be rejected as a network name", n)
		}
	}
	for _, n := range []string{"bouke-hp", "bouke-hp.home", "pc.local", "desk.lan", "host.example.com"} {
		if gatewayVirtualName(n) {
			t.Errorf("%q is a usable network name", n)
		}
	}
}

func TestGatewayHostsNamesFrom(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "hosts")
	body := "# a comment\n" +
		"127.0.0.1 localhost\n" +
		"192.168.0.74 host.docker.internal gateway.docker.internal # added by Docker\n" +
		"\n" +
		"10.0.0.5\tPinned-Name.\n"
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	got := gatewayHostsNamesFrom([]string{filepath.Join(dir, "missing"), p})
	for _, want := range []string{"localhost", "host.docker.internal", "gateway.docker.internal", "pinned-name"} {
		if !got[want] {
			t.Errorf("hosts-file name %q not found in %v", want, got)
		}
	}
	// the address column is not a name, and commented-out names stay out
	for _, no := range []string{"192.168.0.74", "127.0.0.1", "added", "docker"} {
		if got[no] {
			t.Errorf("%q should not count as a hosts-file name", no)
		}
	}
}

// On a machine that runs Docker or WSL this is the regression itself: the
// advertised host must never be virtualization plumbing.
func TestGatewayHostIsReachableName(t *testing.T) {
	h := gatewayHost(gatewayRecord{})
	t.Logf("this machine would advertise %q", h)
	if gatewayVirtualName(h) {
		t.Errorf("gateway advertises %q, which no other machine can resolve", h)
	}
	if strings.HasPrefix(h, "169.254.") {
		t.Errorf("gateway advertises the link-local address %q", h)
	}
}

// The firewall probe must answer coherently and quickly enough to sit behind
// a status call. The verdict itself is a property of this machine, so it is
// logged rather than asserted — only an incoherent answer is a failure.
func TestFirewallProbe(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("no per-profile firewall to read")
	}
	// the real thing: read this machine's rules and judge our own binary
	start := time.Now()
	st := firewallProbe(7444)
	t.Logf("inbound allowed=%v profiles=%q in %s", st.Allowed, st.Profiles,
		time.Since(start).Round(time.Millisecond))
	if !st.checked {
		t.Error("the probe returned no verdict at all")
	}
	if !st.Allowed && st.Profiles == "" {
		t.Error("reported blocked without naming the active profile")
	}
	if fix := firewallFixCommand(); !strings.Contains(fix, "NetFirewallRule") {
		t.Errorf("fix command looks wrong: %q", fix)
	}
}

// A status call must never wait on the probe: the first answer is Pending and
// the verdict lands in the background.
func TestFirewallProbeIsAsync(t *testing.T) {
	firewallInvalidate()
	start := time.Now()
	first := firewallAllowsInbound(7444)
	if took := time.Since(start); took > 200*time.Millisecond {
		t.Errorf("status call blocked for %s on the firewall probe", took.Round(time.Millisecond))
	}
	if runtime.GOOS == "windows" && !first.Pending {
		t.Error("the first call should report Pending, not a guess")
	}
	if !first.Allowed {
		t.Error("an unknown verdict must not be reported as blocked")
	}
	if runtime.GOOS != "windows" {
		return
	}
	// the background answer arrives and then serves from cache
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		if st := firewallAllowsInbound(7444); !st.Pending {
			t.Logf("verdict landed: allowed=%v profiles=%q", st.Allowed, st.Profiles)
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Error("the firewall verdict never arrived")
}

// A pinned host stays untouched: the human overrode the guess on purpose.
func TestGatewayHostPinned(t *testing.T) {
	if h := gatewayHost(gatewayRecord{Host: "my.pinned.name"}); h != "my.pinned.name" {
		t.Errorf("pinned host ignored, got %q", h)
	}
}
