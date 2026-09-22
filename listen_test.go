package main

import (
	"fmt"
	"net"
	"os/exec"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestListenLocalPrefersItsPort(t *testing.T) {
	probe, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	want := probe.Addr().(*net.TCPAddr).Port
	probe.Close()
	ln, got, err := listenLocal("127.0.0.1", want, 20)
	if err != nil {
		t.Fatalf("a free port was refused: %v", err)
	}
	defer ln.Close()
	if got != want {
		t.Errorf("asked for %d, took %d — the preference should win when it is available", want, got)
	}
}

// The bug this protects against, reported 2026-09-22: Windows had reserved
// 7335-7434, so every one of the twenty ports the window tried was refused
// and the process exited before opening anything. Pressing Restart closed
// the window and nothing came back. A reserved BLOCK is the normal case, not
// a corner one — the ranges are re-randomised at every boot.
func TestListenLocalSurvivesAReservedBlock(t *testing.T) {
	const block = 20
	base, held := occupyBlock(t, block)
	defer func() {
		for _, l := range held {
			l.Close()
		}
	}()
	ln, got, err := listenLocal("127.0.0.1", base, block)
	if err != nil {
		t.Fatalf("gave up with the whole preferred range taken: %v", err)
	}
	defer ln.Close()
	if got >= base && got < base+block {
		t.Fatalf("returned %d, inside the block that was supposed to be unavailable", got)
	}
	// and it must be a listener you can actually reach
	c, err := net.DialTimeout("tcp", ln.Addr().String(), 2*time.Second)
	if err != nil {
		t.Fatalf("the fallback port does not accept connections: %v", err)
	}
	c.Close()
}

// occupyBlock holds `n` consecutive ports, the way a reserved range does.
func occupyBlock(t *testing.T, n int) (int, []net.Listener) {
	t.Helper()
	for attempt := 0; attempt < 40; attempt++ {
		probe, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		base := probe.Addr().(*net.TCPAddr).Port
		probe.Close()
		var held []net.Listener
		ok := true
		for i := 0; i < n; i++ {
			l, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", base+i))
			if err != nil {
				ok = false
				break
			}
			held = append(held, l)
		}
		if ok {
			return base, held
		}
		for _, l := range held {
			l.Close()
		}
	}
	t.Skip("could not reserve a consecutive block of ports on this machine")
	return 0, nil
}

// Start() succeeding says a process was created, nothing more. The window
// must not stand down until the replacement has survived its own startup.
func TestSpawnReplacementDetectsAnEarlyExit(t *testing.T) {
	fail := exec.Command("sh", "-c", "echo could not bind a port 1>&2; exit 1")
	live := exec.Command("sh", "-c", "sleep 5")
	if runtime.GOOS == "windows" {
		fail = exec.Command("cmd", "/c", "echo could not bind a port 1>&2& exit 1")
		live = exec.Command("cmd", "/c", "ping -n 6 127.0.0.1 > NUL")
	}

	err := spawnReplacement(fail, 1500*time.Millisecond)
	if err == nil {
		t.Fatal("a replacement that exited at once was reported as up")
	}
	if !strings.Contains(err.Error(), "did not start") || !strings.Contains(err.Error(), "bind a port") {
		t.Errorf("the reason the user needs is the child's own words, not an exit code: %v", err)
	}

	if err := spawnReplacement(live, 400*time.Millisecond); err != nil {
		t.Errorf("a living replacement was called a failure: %v", err)
	}
	if live.Process != nil {
		live.Process.Kill()
	}
}
