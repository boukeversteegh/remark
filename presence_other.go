//go:build !windows

package main

import (
	"fmt"
	"os"
	"strings"
	"syscall"
)

// pidAlive reports whether a process with this pid is running.
func pidAlive(pid int) bool {
	p, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	return p.Signal(syscall.Signal(0)) == nil
}

// pidStartTime identifies a process beyond its number — see the Windows
// version for why that matters. Linux keeps the start time in /proc; where it
// is not available this returns "", and callers must read that as "cannot
// confirm" rather than as a match.
func pidStartTime(pid int) string {
	b, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return ""
	}
	// field 22 is starttime, but fields 2 (comm) may contain spaces and
	// parentheses — everything before the last ')' belongs to it
	s := string(b)
	i := strings.LastIndex(s, ")")
	if i < 0 {
		return ""
	}
	f := strings.Fields(s[i+1:])
	if len(f) < 20 {
		return ""
	}
	return f[19]
}
