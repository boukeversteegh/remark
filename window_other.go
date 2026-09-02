//go:build !windows

package main

import (
	"os/exec"
	"runtime"
)

// runWindow opens the app in a chromium "--app" window (own window, no
// browser chrome) when a chromium-family browser is available. Returns false
// so the caller falls back to the default browser otherwise.
func runWindow(url, title string) bool {
	_ = title // chromium --app windows take their title from the page
	candidates := []string{
		"chromium", "chromium-browser", "google-chrome", "google-chrome-stable",
		"brave-browser", "microsoft-edge", "vivaldi",
	}
	if runtime.GOOS == "darwin" {
		candidates = []string{
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			"/Applications/Chromium.app/Contents/MacOS/Chromium",
			"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
			"/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
		}
	}
	for _, c := range candidates {
		path := c
		if runtime.GOOS != "darwin" {
			p, err := exec.LookPath(c)
			if err != nil {
				continue
			}
			path = p
		} else if _, err := exec.LookPath(path); err != nil {
			continue
		}
		cmd := exec.Command(path, "--app="+url)
		if err := cmd.Start(); err != nil {
			continue
		}
		cmd.Wait()
		return true
	}
	return false
}

func openBrowser(url string) {
	if runtime.GOOS == "darwin" {
		exec.Command("open", url).Start()
	} else {
		exec.Command("xdg-open", url).Start()
	}
}
