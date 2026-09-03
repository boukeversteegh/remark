//go:build windows

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows/registry"
)

// runInstall copies the binary to the per-user Programs directory and adds it
// to the user PATH (HKCU\Environment), broadcasting the change so new shells
// see it without a re-login.
func runInstall() {
	exe, err := os.Executable()
	if err != nil {
		fmt.Fprintln(os.Stderr, "remark install:", err)
		os.Exit(1)
	}
	dir := filepath.Join(os.Getenv("LOCALAPPDATA"), "Programs", "remark")
	dest := filepath.Join(dir, "remark.exe")

	if !strings.EqualFold(exe, dest) {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			fmt.Fprintln(os.Stderr, "remark install:", err)
			os.Exit(1)
		}
		data, err := os.ReadFile(exe)
		if err == nil {
			// a running instance may lock the old file — move it aside first
			if _, statErr := os.Stat(dest); statErr == nil {
				old := dest + ".old~"
				os.Remove(old)
				os.Rename(dest, old)
			}
			err = os.WriteFile(dest, data, 0o755)
		}
		if err != nil {
			fmt.Fprintln(os.Stderr, "remark install:", err)
			os.Exit(1)
		}
		fmt.Println("installed", dest)
	} else {
		fmt.Println("already running from", dest)
	}

	k, err := registry.OpenKey(registry.CURRENT_USER, "Environment", registry.QUERY_VALUE|registry.SET_VALUE)
	if err != nil {
		fmt.Fprintln(os.Stderr, "remark install: open HKCU\\Environment:", err)
		os.Exit(1)
	}
	defer k.Close()
	path, typ, err := k.GetStringValue("Path")
	if err != nil && err != registry.ErrNotExist {
		fmt.Fprintln(os.Stderr, "remark install: read Path:", err)
		os.Exit(1)
	}
	for _, p := range strings.Split(path, ";") {
		if strings.EqualFold(strings.TrimSpace(p), dir) {
			fmt.Println("already on PATH —", dir)
			return
		}
	}
	newPath := strings.TrimRight(path, ";")
	if newPath != "" {
		newPath += ";"
	}
	newPath += dir
	if typ == registry.EXPAND_SZ {
		err = k.SetExpandStringValue("Path", newPath)
	} else {
		err = k.SetStringValue("Path", newPath)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "remark install: write Path:", err)
		os.Exit(1)
	}
	broadcastEnvChange()
	fmt.Println("added to PATH —", dir, "(new terminals will see it)")
}

func broadcastEnvChange() {
	user32 := syscall.NewLazyDLL("user32.dll")
	proc := user32.NewProc("SendMessageTimeoutW")
	env, _ := syscall.UTF16PtrFromString("Environment")
	const (
		hwndBroadcast   = 0xffff
		wmSettingChange = 0x001A
		smtoAbortIfHung = 0x0002
	)
	proc.Call(hwndBroadcast, wmSettingChange, 0,
		uintptr(unsafe.Pointer(env)), smtoAbortIfHung, 5000, 0)
}
