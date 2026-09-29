package main

import (
	"bytes"
	"fmt"
	"net"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// Windows reserves whole BLOCKS of TCP ports — Hyper-V, WSL and container
// networking take ranges that are re-randomised on every boot — and the
// refusal looks nothing like "in use": it is an access-permission error on a
// port nobody is listening on. A walk upwards from a preferred port can
// therefore spend its entire run inside one reserved block and give up with
// every attempt refused, on a machine where thousands of ports are free.
//
// So the walk is only the preference. When it comes to nothing, the OS is
// asked to name a port itself, which it will not do from inside a reserved
// range. A window on an unexpected port works; a window that never opens
// does not.
func listenLocal(host string, preferred, tries int) (net.Listener, int, error) {
	var last error
	for p := preferred; p < preferred+tries; p++ {
		ln, err := net.Listen("tcp", net.JoinHostPort(host, strconv.Itoa(p)))
		if err == nil {
			return ln, p, nil
		}
		last = err
	}
	ln, err := net.Listen("tcp", net.JoinHostPort(host, "0"))
	if err != nil {
		if last == nil {
			last = err
		}
		return nil, 0, last
	}
	return ln, ln.Addr().(*net.TCPAddr).Port, nil
}

// readyEnv names the file a spawned window writes its address to once it is
// serving. Set only by spawnReplacement; a window started any other way
// never looks for it.
const readyEnv = "REMARK_READY"

// spawnReplacement starts the process that is to take this one's place, and
// waits for it to SAY it is serving — not merely to still exist.
//
// Two weaker tests were tried and both are wrong. Start() returning nil
// proves a process was created and nothing else: one that exits a heartbeat
// later, because it could not bind a port or because its executable moved
// under it, leaves whoever pressed Restart with a closed window and nothing
// to read. A grace period is no better in kind — it catches an early exit,
// but a child still starting when the timer runs out is reported as up and
// can fail the moment the old window is gone. Elapsed time is not evidence.
//
// So the child writes its address to a file and this waits for it, then
// connects to prove the claim. If the deadline passes with the child alive
// but silent, that is still a refusal: the caller keeps its window. Two
// windows is a state a person can see and fix. Zero is the one that cost an
// afternoon.
func spawnReplacement(cmd *exec.Cmd, wait time.Duration) error {
	f, err := os.CreateTemp("", "remark-ready-*")
	if err != nil {
		return err
	}
	path := f.Name()
	f.Close()
	os.Remove(path) // the child CREATES it; its appearance is the signal
	defer os.Remove(path)

	env := cmd.Env
	if env == nil {
		env = os.Environ()
	}
	cmd.Env = append(env, readyEnv+"="+path)

	var errOut bytes.Buffer
	if cmd.Stderr == nil {
		cmd.Stderr = &errOut
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()

	deadline := time.Now().Add(wait)
	for {
		if b, err := os.ReadFile(path); err == nil && len(b) > 0 {
			addr := strings.TrimSpace(string(b))
			c, err := net.DialTimeout("tcp", addr, 2*time.Second)
			if err == nil {
				c.Close()
				return nil // bound, accepting, and it said so itself
			}
			return fmt.Errorf("the new window reported %s but is not answering there: %v", addr, err)
		}
		select {
		case err := <-exited:
			why := strings.TrimSpace(errOut.String())
			if why == "" {
				why = "it exited during startup"
				if err != nil {
					why = "it exited during startup: " + err.Error()
				}
			}
			return fmt.Errorf("the new window did not start — %s", why)
		default:
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("the new window has not reported itself serving within %s — "+
				"this one is staying open rather than closing on a maybe", wait)
		}
		time.Sleep(40 * time.Millisecond)
	}
}

// excludedRangeNote explains a fallback in the terms the user can check.
func excludedRangeNote(preferred, tries, got int) string {
	return fmt.Sprintf("ports %d-%d are not available on this machine (Windows reserves blocks of them; "+
		"`netsh int ipv4 show excludedportrange protocol=tcp` lists them) — using %d instead",
		preferred, preferred+tries-1, got)
}
