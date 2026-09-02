//go:build windows

package main

import (
	"os/exec"
	"syscall"
	"unsafe"

	webview2 "github.com/jchv/go-webview2"
	"golang.org/x/sys/windows/registry"
)

var (
	dwmapi                  = syscall.NewLazyDLL("dwmapi.dll")
	pDwmSetWindowAttribute  = dwmapi.NewProc("DwmSetWindowAttribute")
)

const (
	dwmwaUseImmersiveDarkMode = 20
	dwmwaCaptionColor         = 35
	dwmwaTextColor            = 36
)

func colorref(r, g, b uint32) uint32 { return r | g<<8 | b<<16 }

func isDarkTheme() bool {
	k, err := registry.OpenKey(registry.CURRENT_USER,
		`Software\Microsoft\Windows\CurrentVersion\Themes\Personalize`, registry.QUERY_VALUE)
	if err != nil {
		return false
	}
	defer k.Close()
	v, _, err := k.GetIntegerValue("AppsUseLightTheme")
	return err == nil && v == 0
}

// styleTitleBar paints the caption in the app's own background color so the
// title bar blends with the page, Windows 11 style. Silently a no-op on
// Windows 10 (the DWM attributes don't exist there).
func styleTitleBar(hwnd uintptr) {
	var caption, text uint32
	if isDarkTheme() {
		dark := int32(1)
		pDwmSetWindowAttribute.Call(hwnd, dwmwaUseImmersiveDarkMode, uintptr(unsafe.Pointer(&dark)), 4)
		caption = colorref(0x0c, 0x11, 0x16)
		text = colorref(0xe4, 0xea, 0xf1)
	} else {
		caption = colorref(0xfb, 0xfc, 0xfd)
		text = colorref(0x1c, 0x21, 0x28)
	}
	pDwmSetWindowAttribute.Call(hwnd, dwmwaCaptionColor, uintptr(unsafe.Pointer(&caption)), 4)
	pDwmSetWindowAttribute.Call(hwnd, dwmwaTextColor, uintptr(unsafe.Pointer(&text)), 4)
}

// runWindow opens the app in a native WebView2 window. Returns false if the
// WebView2 runtime is unavailable so the caller can fall back to a browser.
func runWindow(url, title string) bool {
	w := webview2.NewWithOptions(webview2.WebViewOptions{
		Debug:     false,
		AutoFocus: true,
		WindowOptions: webview2.WindowOptions{
			Title:  title,
			Width:  1280,
			Height: 940,
			IconId: 1, // embedded via rsrc_windows_amd64.syso (assets/icon.ico)
			Center: true,
		},
	})
	if w == nil {
		return false
	}
	defer w.Destroy()
	styleTitleBar(uintptr(w.Window()))
	w.Navigate(url)
	w.Run()
	return true
}

func openBrowser(url string) {
	exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
}
