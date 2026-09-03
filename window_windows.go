//go:build windows

package main

import (
	"os/exec"
	"syscall"
	"time"
	"unsafe"

	webview2 "github.com/jchv/go-webview2"
	"golang.org/x/sys/windows/registry"
)

var (
	dwmapi                 = syscall.NewLazyDLL("dwmapi.dll")
	pDwmSetWindowAttribute = dwmapi.NewProc("DwmSetWindowAttribute")
	user32                 = syscall.NewLazyDLL("user32.dll")
	pLoadIconW             = user32.NewProc("LoadIconW")
	pSendMessageW          = user32.NewProc("SendMessageW")
	kernel32               = syscall.NewLazyDLL("kernel32.dll")
	pGetModuleHandleW      = kernel32.NewProc("GetModuleHandleW")
	pGetWindowPlacement    = user32.NewProc("GetWindowPlacement")
	pSetWindowPlacement    = user32.NewProc("SetWindowPlacement")
	pGetSystemMetrics      = user32.NewProc("GetSystemMetrics")
	pShowWindow            = user32.NewProc("ShowWindow")
	pRegisterClassExW      = user32.NewProc("RegisterClassExW")
	pCreateWindowExW       = user32.NewProc("CreateWindowExW")
	pDestroyWindow         = user32.NewProc("DestroyWindow")
	pDefWindowProcW        = user32.NewProc("DefWindowProcW")
	pBeginPaint            = user32.NewProc("BeginPaint")
	pEndPaint              = user32.NewProc("EndPaint")
	pGetClientRect         = user32.NewProc("GetClientRect")
	pDrawIconEx            = user32.NewProc("DrawIconEx")
	pUpdateWindow          = user32.NewProc("UpdateWindow")
	gdi32                  = syscall.NewLazyDLL("gdi32.dll")
	pCreateSolidBrush      = gdi32.NewProc("CreateSolidBrush")
)

// window placement persisted to prefs so size/position (and maximized
// state) survive restarts; the most recently moved window wins.
type winPlacement struct {
	Cmd int32 `json:"cmd"` // 1 = normal, 3 = maximized
	X   int32 `json:"x"`
	Y   int32 `json:"y"`
	R   int32 `json:"r"`
	B   int32 `json:"b"`
}

type windowPlacementW struct {
	length, flags, showCmd         uint32
	minX, minY, maxX, maxY         int32
	normX, normY, normR, normB     int32
}

func metric(i uintptr) int32 {
	v, _, _ := pGetSystemMetrics.Call(i)
	return int32(v)
}

func restoreWindowBounds(hwnd uintptr) bool {
	var p winPlacement
	if !prefsGetKey("win", &p) || p.R-p.X < 400 || p.B-p.Y < 300 {
		return false
	}
	// ignore stale bounds that fall outside the current virtual screen
	vx, vy := metric(76), metric(77) // SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN
	vw, vh := metric(78), metric(79) // SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN
	if p.R < vx+40 || p.X > vx+vw-40 || p.B < vy+40 || p.Y > vy+vh-40 {
		return false
	}
	if p.Cmd != 3 {
		p.Cmd = 1
	}
	wp := windowPlacementW{
		showCmd: uint32(p.Cmd),
		normX:   p.X, normY: p.Y, normR: p.R, normB: p.B,
	}
	wp.length = uint32(unsafe.Sizeof(wp))
	pSetWindowPlacement.Call(hwnd, uintptr(unsafe.Pointer(&wp)))
	return true
}

func trackWindowBounds(hwnd uintptr, stop chan struct{}) {
	var last winPlacement
	t := time.NewTicker(2 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-stop:
			return
		case <-t.C:
			var wp windowPlacementW
			wp.length = uint32(unsafe.Sizeof(wp))
			ok, _, _ := pGetWindowPlacement.Call(hwnd, uintptr(unsafe.Pointer(&wp)))
			if ok == 0 || wp.showCmd == 2 { // ignore minimized
				continue
			}
			cur := winPlacement{
				Cmd: int32(wp.showCmd),
				X:   wp.normX, Y: wp.normY, R: wp.normR, B: wp.normB,
			}
			if cur != last {
				last = cur
				prefsSetKey("win", cur)
			}
		}
	}
}

// setWindowIcon loads the embedded icon group and applies it to the window
// (title bar, taskbar, alt-tab). Loading by resource id at runtime is more
// reliable than the window-class icon id, which fails silently when the
// group id doesn't match.
func setWindowIcon(hwnd uintptr) {
	hInst, _, _ := pGetModuleHandleW.Call(0)
	for id := uintptr(1); id <= 32; id++ {
		icon, _, _ := pLoadIconW.Call(hInst, id)
		if icon != 0 {
			const wmSetIcon = 0x0080
			pSendMessageW.Call(hwnd, wmSetIcon, 1, icon) // ICON_BIG
			pSendMessageW.Call(hwnd, wmSetIcon, 0, icon) // ICON_SMALL
			return
		}
	}
}

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
type wndClassExW struct {
	size, style                        uint32
	wndProc, clsExtra, wndExtra        uintptr
	instance, icon, cursor, background uintptr
	menuName, className                *uint16
	iconSm                             uintptr
}

type paintStructW struct {
	hdc         uintptr
	erase       int32
	rc          [4]int32
	restore     int32
	incUpdate   int32
	rgbReserved [32]byte
}

var splashIconH uintptr

// splashProc paints the app icon centered on the theme-colored card.
var splashProc = syscall.NewCallback(func(hwnd, msg, wparam, lparam uintptr) uintptr {
	if msg == 0x000F { // WM_PAINT
		var ps paintStructW
		hdc, _, _ := pBeginPaint.Call(hwnd, uintptr(unsafe.Pointer(&ps)))
		var rc [4]int32
		pGetClientRect.Call(hwnd, uintptr(unsafe.Pointer(&rc)))
		const sz = 48
		pDrawIconEx.Call(hdc,
			uintptr(int32((rc[2]-rc[0])/2-sz/2)), uintptr(int32((rc[3]-rc[1])/2-sz/2)),
			splashIconH, sz, sz, 0, 0, 3 /* DI_NORMAL */)
		pEndPaint.Call(hwnd, uintptr(unsafe.Pointer(&ps)))
		return 0
	}
	r, _, _ := pDefWindowProcW.Call(hwnd, msg, wparam, lparam)
	return r
})

// showSplash puts up a small fixed-size centered window in the theme's
// background color with the app icon, instantly — it covers window creation
// and WebView2 initialization while the real window stays hidden.
func showSplash() func() {
	inst, _, _ := pGetModuleHandleW.Call(0)
	// theme-matching brush (same registry read the titlebar uses)
	bg := uintptr(0x00fdfcfb) // light --bg, BGR
	if k, err := registry.OpenKey(registry.CURRENT_USER,
		`Software\Microsoft\Windows\CurrentVersion\Themes\Personalize`, registry.QUERY_VALUE); err == nil {
		if v, _, err := k.GetIntegerValue("AppsUseLightTheme"); err == nil && v == 0 {
			bg = uintptr(0x0016110c) // dark --bg, BGR
		}
		k.Close()
	}
	splashIconH, _, _ = pLoadIconW.Call(inst, 1) // the embedded app icon
	brush, _, _ := pCreateSolidBrush.Call(bg)
	cls, _ := syscall.UTF16PtrFromString("remarkSplash")
	wc := wndClassExW{
		wndProc:    splashProc,
		instance:   inst,
		background: brush,
		className:  cls,
	}
	wc.size = uint32(unsafe.Sizeof(wc))
	pRegisterClassExW.Call(uintptr(unsafe.Pointer(&wc)))
	const w, h = 320, 160
	sw, sh := metric(0), metric(1) // SM_CXSCREEN, SM_CYSCREEN
	const wsPopup, wsVisible = 0x80000000, 0x10000000
	const exToolWindow, exTopmost = 0x80, 0x8
	hwnd, _, _ := pCreateWindowExW.Call(exToolWindow|exTopmost,
		uintptr(unsafe.Pointer(cls)), 0, wsPopup|wsVisible,
		uintptr(int32(sw/2-w/2)), uintptr(int32(sh/2-h/2)), w, h, 0, 0, inst, 0)
	pUpdateWindow.Call(hwnd)
	return func() {
		if hwnd != 0 {
			pDestroyWindow.Call(hwnd)
		}
	}
}

func runWindow(url, title string) bool {
	// splash FIRST: it must be on screen before the webview window is even
	// created, so nothing white ever paints uncovered
	splashGone := showSplash()
	// create the window at its RESTORED size, so restoring bounds after
	// creation only repositions it — no visible resize jump on launch
	width, height := 1280, 940
	var p winPlacement
	if prefsGetKey("win", &p) && p.R-p.X >= 400 && p.B-p.Y >= 300 {
		width, height = int(p.R-p.X), int(p.B-p.Y)
	}
	w := webview2.NewWithOptions(webview2.WebViewOptions{
		Debug:     false,
		AutoFocus: true,
		WindowOptions: webview2.WindowOptions{
			Title:  title,
			Width:  uint(width),
			Height: uint(height),
			IconId: 1, // embedded via rsrc_windows_amd64.syso (assets/icon.ico)
			Center: true,
		},
	})
	if w == nil {
		return false
	}
	defer w.Destroy()
	hwnd := uintptr(w.Window())
	// hide immediately: the real window stays invisible (behind the splash)
	// until the UI reports its first paint, then appears once, at its final
	// placement — no white flash, no resize jump
	pShowWindow.Call(hwnd, 0) // SW_HIDE
	styleTitleBar(hwnd)
	setWindowIcon(hwnd)
	stop := make(chan struct{})
	defer close(stop)
	go func() {
		select {
		case <-uiReady:
		case <-time.After(6 * time.Second): // failsafe: never stay hidden
		}
		splashGone()
		if !restoreWindowBounds(hwnd) {
			pShowWindow.Call(hwnd, 5) // SW_SHOW
		}
		go trackWindowBounds(hwnd, stop)
	}()
	w.Navigate(url)
	w.Run()
	return true
}

func openBrowser(url string) {
	exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
}
