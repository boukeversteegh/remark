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
			// a running instance may lock the old file — move it aside first;
			// fall back to a unique name if a previous .old~ is itself locked
			if _, statErr := os.Stat(dest); statErr == nil {
				old := dest + ".old~"
				os.Remove(old)
				if renameErr := os.Rename(dest, old); renameErr != nil {
					old = fmt.Sprintf("%s.old-%d~", dest, os.Getpid())
					if renameErr = os.Rename(dest, old); renameErr != nil {
						fmt.Fprintln(os.Stderr, "remark install: cannot replace the running binary — close remark windows and run `remark install` again")
						os.Exit(1)
					}
				}
			}
			err = os.WriteFile(dest, data, 0o755)
		}
		if err != nil {
			fmt.Fprintln(os.Stderr, "remark install:", err)
			os.Exit(1)
		}
		sweepOldBinaries()
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

// sweepOldBinaries deletes the ".old" images hot reinstalls leave behind.
// A Windows binary cannot delete its own running image, so instead EVERY
// remark start attempts the sweep: files still backing a live process are
// locked and refuse deletion (which is exactly right), dead ones vanish.
func sweepOldBinaries() {
	dir := filepath.Join(os.Getenv("LOCALAPPDATA"), "Programs", "remark")
	if stale, _ := filepath.Glob(filepath.Join(dir, "remark.exe.old*")); stale != nil {
		for _, s := range stale {
			os.Remove(s)
		}
	}
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
