//go:build !windows

package main

import (
	"os"
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
