package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
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

// A pinned host stays untouched: the human overrode the guess on purpose.
func TestGatewayHostPinned(t *testing.T) {
	if h := gatewayHost(gatewayRecord{Host: "my.pinned.name"}); h != "my.pinned.name" {
		t.Errorf("pinned host ignored, got %q", h)
	}
}
