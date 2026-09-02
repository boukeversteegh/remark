//go:build !windows

package main

import (
	"os/exec"
	"runtime"
	"strings"
)

// pickFile shows a native-ish open dialog where one is available (zenity on
// Linux, osascript on macOS). Returns "" if unavailable or cancelled.
func pickFile(initialDir string) string {
	switch runtime.GOOS {
	case "darwin":
		out, err := exec.Command("osascript", "-e",
			`POSIX path of (choose file with prompt "Open markdown file")`).Output()
		if err != nil {
			return ""
		}
		return strings.TrimSpace(string(out))
	default:
		if _, err := exec.LookPath("zenity"); err != nil {
			return ""
		}
		args := []string{"--file-selection", "--title=Open markdown file"}
		if initialDir != "" {
			args = append(args, "--filename="+initialDir+"/")
		}
		out, err := exec.Command("zenity", args...).Output()
		if err != nil {
			return ""
		}
		return strings.TrimSpace(string(out))
	}
}
