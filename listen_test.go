package main

import (
	"fmt"
	"net"
	"os"
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

// sh runs a one-line script in whatever shell this platform has.
func sh(script, winScript string) *exec.Cmd {
	if runtime.GOOS == "windows" {
		return exec.Command("cmd", "/c", winScript)
	}
	return exec.Command("sh", "-c", script)
}

// Start() succeeding says a process was created, nothing more.
func TestSpawnReplacementDetectsAnEarlyExit(t *testing.T) {
	fail := sh("echo could not bind a port 1>&2; exit 1",
		"echo could not bind a port 1>&2& exit 1")
	err := spawnReplacement(fail, 2*time.Second)
	if err == nil {
		t.Fatal("a replacement that exited at once was reported as up")
	}
	if !strings.Contains(err.Error(), "did not start") || !strings.Contains(err.Error(), "bind a port") {
		t.Errorf("the reason the user needs is the child's own words, not an exit code: %v", err)
	}
}

// Raised by Codex, 2026-09-22: a grace period detects an early exit but
// never establishes readiness. This child outlives the wait and then fails,
// having signalled nothing — the case a timer calls a success and hands the
// user a closed window.
func TestSpawnReplacementRefusesASilentChild(t *testing.T) {
	slow := sh("sleep 3; exit 1", "ping -n 4 127.0.0.1 > NUL& exit 1")
	start := time.Now()
	err := spawnReplacement(slow, 700*time.Millisecond)
	if err == nil {
		t.Fatal("a child that never said it was serving was reported as up")
	}
	if !strings.Contains(err.Error(), "staying open") {
		t.Errorf("the old window has to be told it is keeping its place: %v", err)
	}
	if d := time.Since(start); d > 2*time.Second {
		t.Errorf("waited %s — the refusal should come at the deadline, not at the child's death", d)
	}
	if slow.Process != nil {
		slow.Process.Kill()
	}
}

// The success path is a child that writes its address and answers there —
// nothing weaker counts.
func TestSpawnReplacementAcceptsAServingChild(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			c.Close()
		}
	}()

	live := sh(`printf %s "$REMARK_ADDR" > "$REMARK_READY"; sleep 5`,
		// leading redirect: a digit right before ">" is a file handle to cmd,
		// and an address ends in one. No quotes either — Go escapes them for
		// an argv cmd.exe does not parse that way.
		`>%REMARK_READY% echo %REMARK_ADDR%& ping -n 6 127.0.0.1 > NUL`)
	live.Env = append(os.Environ(), "REMARK_ADDR="+ln.Addr().String())
	if err := spawnReplacement(live, 5*time.Second); err != nil {
		t.Errorf("a child that reported itself serving was called a failure: %v", err)
	}
	if live.Process != nil {
		live.Process.Kill()
	}

	// and a child that reports an address nothing is listening on is not up
	dead, _ := net.Listen("tcp", "127.0.0.1:0")
	gone := dead.Addr().String()
	dead.Close()
	liar := sh(`printf %s "$REMARK_ADDR" > "$REMARK_READY"; sleep 5`,
		// leading redirect: a digit right before ">" is a file handle to cmd,
		// and an address ends in one. No quotes either — Go escapes them for
		// an argv cmd.exe does not parse that way.
		`>%REMARK_READY% echo %REMARK_ADDR%& ping -n 6 127.0.0.1 > NUL`)
	liar.Env = append(os.Environ(), "REMARK_ADDR="+gone)
	if err := spawnReplacement(liar, 3*time.Second); err == nil {
		t.Error("an address nobody answers at was taken at its word")
	}
	if liar.Process != nil {
		liar.Process.Kill()
	}
}
