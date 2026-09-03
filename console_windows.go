//go:build windows

package main

import (
	"os"
	"syscall"
)

// attachConsole connects a -H windowsgui binary back to the console it was
// launched from, so `remark --help`, `remark monitor`, `remark install` print
// in an interactive terminal. Launched from Explorer there is no parent
// console and this is a no-op; redirected/piped handles are left untouched.
func attachConsole() {
	k := syscall.NewLazyDLL("kernel32.dll")
	r, _, _ := k.NewProc("AttachConsole").Call(^uintptr(0)) // ATTACH_PARENT_PROCESS
	if r == 0 {
		return
	}
	// our output is UTF-8; classic conhost defaults to the OEM codepage and
	// renders em-dashes as mojibake
	k.NewProc("SetConsoleOutputCP").Call(65001)
	if _, err := os.Stdout.Stat(); err != nil {
		if f, e := os.OpenFile("CONOUT$", os.O_WRONLY, 0); e == nil {
			os.Stdout = f
		}
	}
	if _, err := os.Stderr.Stat(); err != nil {
		if f, e := os.OpenFile("CONOUT$", os.O_WRONLY, 0); e == nil {
			os.Stderr = f
		}
	}
}
