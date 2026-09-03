//go:build !windows

package main

// console-subsystem binaries are already attached to their terminal.
func attachConsole() {}
