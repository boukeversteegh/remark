package main

import (
	"bytes"
	"fmt"
	"net"
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

// spawnReplacement starts a process that is about to take this one's place,
// and waits long enough to see whether it survives its own startup. Start()
// returning nil only proves a process was CREATED: one that exits a
// heartbeat later — because it could not bind a port, because its
// executable was replaced mid-flight — leaves a user who pressed Restart
// with a closed window and nothing to read. The caller must not exit until
// this says the replacement is up.
func spawnReplacement(cmd *exec.Cmd, grace time.Duration) error {
	var errOut bytes.Buffer
	if cmd.Stderr == nil {
		cmd.Stderr = &errOut
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		why := strings.TrimSpace(errOut.String())
		if why == "" {
			why = "it exited immediately"
			if err != nil {
				why = "it exited immediately: " + err.Error()
			}
		}
		return fmt.Errorf("the new window did not start — %s", why)
	case <-time.After(grace):
		return nil // still alive: it got past binding and is opening
	}
}

// excludedRangeNote explains a fallback in the terms the user can check.
func excludedRangeNote(preferred, tries, got int) string {
	return fmt.Sprintf("ports %d-%d are not available on this machine (Windows reserves blocks of them; "+
		"`netsh int ipv4 show excludedportrange protocol=tcp` lists them) — using %d instead",
		preferred, preferred+tries-1, got)
}
