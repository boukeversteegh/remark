//go:build windows

package main

import (
	"fmt"
	"os"
	"os/exec"
	"reflect"
	"runtime"
	"syscall"
	"time"
	"unsafe"

	webview2 "github.com/jchv/go-webview2"
	"github.com/jchv/go-webview2/pkg/edge"
	"golang.org/x/sys/windows"
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
	pLoadImageW            = user32.NewProc("LoadImageW")
	pUpdateWindow          = user32.NewProc("UpdateWindow")
	pFindWindowW           = user32.NewProc("FindWindowW")
	pSetWindowPos          = user32.NewProc("SetWindowPos")
	pSetWindowsHookExW     = user32.NewProc("SetWindowsHookExW")
	pUnhookWindowsHookEx   = user32.NewProc("UnhookWindowsHookEx")
	pCallNextHookEx        = user32.NewProc("CallNextHookEx")
	pGetCurrentThreadId    = kernel32.NewProc("GetCurrentThreadId")
	pSetClassLongPtrW      = user32.NewProc("SetClassLongPtrW")
	pSetForegroundWindow   = user32.NewProc("SetForegroundWindow")
	pMonitorFromRect       = user32.NewProc("MonitorFromRect")
	pGetMonitorInfoW       = user32.NewProc("GetMonitorInfoW")
	gdi32                  = syscall.NewLazyDLL("gdi32.dll")
	pCreateSolidBrush      = gdi32.NewProc("CreateSolidBrush")
	pDrawIconEx            = user32.NewProc("DrawIconEx")
	pDrawTextW             = user32.NewProc("DrawTextW")
	pCreateFontW           = gdi32.NewProc("CreateFontW")
	pSetTextColor          = gdi32.NewProc("SetTextColor")
	pSetBkMode             = gdi32.NewProc("SetBkMode")
	pSelectObject          = gdi32.NewProc("SelectObject")
	pDeleteObject          = gdi32.NewProc("DeleteObject")
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
	length, flags, showCmd     uint32
	minX, minY, maxX, maxY     int32
	normX, normY, normR, normB int32
}

func metric(i uintptr) int32 {
	v, _, _ := pGetSystemMetrics.Call(i)
	return int32(v)
}

// workAreaSize returns the work-area dimensions of the monitor containing
// the given rect — the size a maximized window will actually have there.
func workAreaSize(x, y, r, b int32) (int32, int32, bool) {
	rc := struct{ l, t, r, b int32 }{x, y, r, b}
	mon, _, _ := pMonitorFromRect.Call(uintptr(unsafe.Pointer(&rc)), 2 /*MONITOR_DEFAULTTONEAREST*/)
	if mon == 0 {
		return 0, 0, false
	}
	var mi struct {
		size                       uint32
		monL, monT, monR, monB     int32
		workL, workT, workR, workB int32
		flags                      uint32
	}
	mi.size = uint32(unsafe.Sizeof(mi))
	if ok, _, _ := pGetMonitorInfoW.Call(mon, uintptr(unsafe.Pointer(&mi))); ok == 0 {
		return 0, 0, false
	}
	return mi.workR - mi.workL, mi.workB - mi.workT, true
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
	wndProc                            uintptr
	clsExtra, wndExtra                 int32
	instance, icon, cursor, background uintptr
	menuName, className                *uint16
	iconSm                             uintptr
}

var splashIconH uintptr

// splashDbg prints splash diagnostics in console builds; silent under
// -H windowsgui unless a console is attached.
func splashDbg(f string, a ...any) {
	fmt.Fprintf(os.Stderr, "splash: "+f+"\n", a...)
}

// showSplash puts up a small fixed-size centered window in the theme's
// background color with the app icon, instantly — it covers window creation
// and WebView2 initialization while the real window stays hidden.
const splashW, splashH = 184, 172

// splashPaint draws the card: the app icon at 96px with real alpha over the
// theme background (a STATIC control painted transparent pixels white and
// capped the size — the old complaints), and the wordmark beneath it.
func splashPaint(hdc uintptr) {
	if splashIconH != 0 {
		pDrawIconEx.Call(hdc, (splashW-96)/2, 22, splashIconH, 96, 96, 0, 0, 3 /*DI_NORMAL*/)
	}
	name, _ := syscall.UTF16PtrFromString("Segoe UI")
	font, _, _ := pCreateFontW.Call(^uintptr(27) /*-28px*/, 0, 0, 0, 600, /*semibold*/
		0, 0, 0, 0, 0, 0, 5 /*CLEARTYPE_QUALITY*/, 0, uintptr(unsafe.Pointer(name)))
	old, _, _ := pSelectObject.Call(hdc, font)
	pSetBkMode.Call(hdc, 1 /*TRANSPARENT*/)
	fg := uintptr(colorref(0x1c, 0x21, 0x28))
	if isDarkTheme() {
		fg = uintptr(colorref(0xe4, 0xea, 0xf1))
	}
	pSetTextColor.Call(hdc, fg)
	txt, _ := syscall.UTF16PtrFromString("remark")
	rect := struct{ l, t, r, b int32 }{0, 126, splashW, 158}
	pDrawTextW.Call(hdc, uintptr(unsafe.Pointer(txt)), ^uintptr(0), /*-1*/
		uintptr(unsafe.Pointer(&rect)), 0x1|0x20 /*DT_CENTER|DT_SINGLELINE*/)
	pSelectObject.Call(hdc, old)
	pDeleteObject.Call(font)
}

var splashWndProc = syscall.NewCallback(func(hwnd, msg, wp, lp uintptr) uintptr {
	if msg == 0x000F { // WM_PAINT
		var ps [72]byte // PAINTSTRUCT
		hdc, _, _ := pBeginPaint.Call(hwnd, uintptr(unsafe.Pointer(&ps[0])))
		if hdc != 0 {
			splashPaint(hdc)
			pEndPaint.Call(hwnd, uintptr(unsafe.Pointer(&ps[0])))
		}
		return 0
	}
	r, _, _ := pDefWindowProcW.Call(hwnd, msg, wp, lp)
	return r
})

func showSplash() func() {
	inst, _, _ := pGetModuleHandleW.Call(0)
	bg := themeBGR()
	// the embedded app icon — rsrc assigns it an id somewhere in 1..32
	for id := uintptr(1); id <= 32 && splashIconH == 0; id++ {
		splashIconH, _, _ = pLoadImageW.Call(inst, id, 1 /*IMAGE_ICON*/, 96, 96, 0)
	}
	splashDbg("icon handle: %d", splashIconH)
	brush, _, _ := pCreateSolidBrush.Call(bg)
	cls, _ := syscall.UTF16PtrFromString("remarkSplash")
	wc := wndClassExW{
		wndProc:    splashWndProc,
		instance:   inst,
		background: brush,
		className:  cls,
	}
	wc.size = uint32(unsafe.Sizeof(wc))
	pRegisterClassExW.Call(uintptr(unsafe.Pointer(&wc)))
	sw, sh := metric(0), metric(1) // SM_CXSCREEN, SM_CYSCREEN
	const wsPopup, wsVisible = 0x80000000, 0x10000000
	const exToolWindow, exTopmost = 0x80, 0x8
	hwnd, _, _ := pCreateWindowExW.Call(exToolWindow|exTopmost,
		uintptr(unsafe.Pointer(cls)), 0, wsPopup|wsVisible,
		uintptr(int32(sw/2-splashW/2)), uintptr(int32(sh/2-splashH/2)),
		splashW, splashH, 0, 0, inst, 0)
	if hwnd != 0 {
		round := int32(2)                     // DWMWCP_ROUND — Windows 11 rounded corners
		pDwmSetWindowAttribute.Call(hwnd, 33, /*DWMWA_WINDOW_CORNER_PREFERENCE*/
			uintptr(unsafe.Pointer(&round)), 4)
	}
	pUpdateWindow.Call(hwnd)
	return func() {
		if hwnd != 0 {
			pDestroyWindow.Call(hwnd)
		}
	}
}

// themeBGR is the app's --bg page color as a COLORREF (0x00BBGGRR), picked
// by the same registry read the titlebar and splash use.
func themeBGR() uintptr {
	bg := uintptr(0x00fdfcfb) // light --bg, BGR
	if k, err := registry.OpenKey(registry.CURRENT_USER,
		`Software\Microsoft\Windows\CurrentVersion\Themes\Personalize`, registry.QUERY_VALUE); err == nil {
		if v, _, err := k.GetIntegerValue("AppsUseLightTheme"); err == nil && v == 0 {
			bg = uintptr(0x0016110c) // dark --bg, BGR
		}
		k.Close()
	}
	return bg
}

// setWebViewBackground makes WebView2 paint freshly exposed area in the
// theme color instead of its default white, so resizing never flashes.
// The library keeps its Chromium unexported, so this reaches through the
// field reflectively; any failure just means the default white stays.
func setWebViewBackground(w webview2.WebView) {
	defer func() { recover() }()
	rv := reflect.ValueOf(w)
	if rv.Kind() != reflect.Ptr || rv.IsNil() {
		return
	}
	f := rv.Elem().FieldByName("browser")
	if !f.IsValid() {
		return
	}
	f = reflect.NewAt(f.Type(), unsafe.Pointer(f.UnsafeAddr())).Elem()
	chrom, ok := f.Interface().(*edge.Chromium)
	if !ok || chrom == nil {
		return
	}
	ctl := chrom.GetController()
	if ctl == nil {
		return
	}
	c2 := ctl.GetICoreWebView2Controller2()
	if c2 == nil {
		return
	}
	bgr := themeBGR()
	c2.PutDefaultBackgroundColor(edge.COREWEBVIEW2_COLOR{
		A: 255, R: uint8(bgr), G: uint8(bgr >> 8), B: uint8(bgr >> 16),
	})
}

type cbtCreateWndW struct {
	lpcs        *createStructW
	insertAfter uintptr
}

type createStructW struct {
	createParams, instance, menu, parent uintptr
	cy, cx, y, x, style                  int32
	_                                    int32
	name, class                          *uint16
	exStyle                              uint32
}

// cbtOffscreenProc rewrites creation coordinates of the "webview" class
// window so it is created off-screen; everything else passes through.
var cbtOffscreenProc = syscall.NewCallback(func(nCode, wparam, lparam uintptr) uintptr {
	if nCode == 3 /*HCBT_CREATEWND*/ && lparam != 0 {
		cw := (*cbtCreateWndW)(unsafe.Pointer(lparam))
		if cw.lpcs != nil && uintptr(unsafe.Pointer(cw.lpcs.class)) > 0xFFFF &&
			windows.UTF16PtrToString(cw.lpcs.class) == "webview" {
			cw.lpcs.x = -32000
			cw.lpcs.y = -32000
		}
	}
	r, _, _ := pCallNextHookEx.Call(0, nCode, wparam, lparam)
	return r
})

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
	// the library shows its window DURING creation and pumps messages while
	// WebView2 initializes. A same-thread CBT hook rewrites the window's
	// CREATESTRUCT so it is BORN far off-screen — raceless, not a single
	// frame ever paints on screen (moving or hiding it after creation always
	// leaked one; and truly hiding it breaks WebView2 embedding).
	// official WebView2 knob: the runtime reads this env var and uses it as
	// the controller's initial background, before any API call could — the
	// documented fix for the startup white flicker (AARRGGBB hex)
	bgr := themeBGR()
	os.Setenv("WEBVIEW2_DEFAULT_BACKGROUND_COLOR",
		fmt.Sprintf("FF%02X%02X%02X", uint8(bgr), uint8(bgr>>8), uint8(bgr>>16)))
	runtime.LockOSThread()
	tid, _, _ := pGetCurrentThreadId.Call()
	hook, _, _ := pSetWindowsHookExW.Call(5 /*WH_CBT*/, cbtOffscreenProc, 0, tid)
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
	if hook != 0 {
		pUnhookWindowsHookEx.Call(hook)
	}
	if w == nil {
		return false
	}
	defer w.Destroy()
	hwnd := uintptr(w.Window())
	// the window stays VISIBLE but off-screen: WebView2 keeps rendering
	// there, so the reveal is a pure move of already-painted content
	styleTitleBar(hwnd)
	setWindowIcon(hwnd)
	// erase color + WebView2 background = theme color, so no resize —
	// launch or user-driven — can ever expose white
	brush, _, _ := pCreateSolidBrush.Call(themeBGR())
	pSetClassLongPtrW.Call(hwnd, ^uintptr(9) /*GCLP_HBRBACKGROUND=-10*/, brush)
	setWebViewBackground(w)
	stop := make(chan struct{})
	defer close(stop)
	go func() {
		select {
		case <-uiReady:
		case <-time.After(6 * time.Second): // failsafe: never stay hidden
		}
		// stage 1, still off-screen: adopt the FINAL size. A maximized
		// placement is the violent case — the window was created at its
		// normal-rect size, so size it to the target monitor's work area
		// and let the page lay out and paint where nobody can see it.
		tw, th := int32(width), int32(height)
		var p winPlacement
		if prefsGetKey("win", &p) && p.R-p.X >= 400 && p.B-p.Y >= 300 {
			tw, th = p.R-p.X, p.B-p.Y
			if p.Cmd == 3 {
				if ww, wh, ok := workAreaSize(p.X, p.Y, p.R, p.B); ok {
					tw, th = ww, wh
				}
			}
		}
		const swpNoZorderNoActivate = 0x4 | 0x10
		w.Dispatch(func() {
			pSetWindowPos.Call(hwnd, 0, ^uintptr(31999), ^uintptr(31999),
				uintptr(tw), uintptr(th), swpNoZorderNoActivate)
		})
		// a beat for WebView2 to resize its controller and repaint
		time.Sleep(200 * time.Millisecond)
		// stage 2: reveal — window operations must run on the UI thread;
		// DestroyWindow in particular silently fails cross-thread (which
		// left windows invisible behind an immortal splash)
		w.Dispatch(func() {
			// no DWM maximize/restore animation for the reveal itself —
			// the window must SNAP into place, already painted, not tween
			// from its normal rect while the user watches
			noAnim := int32(1)
			pDwmSetWindowAttribute.Call(hwnd, 3, /*DWMWA_TRANSITIONS_FORCEDISABLED*/
				uintptr(unsafe.Pointer(&noAnim)), 4)
			if !restoreWindowBounds(hwnd) {
				// no saved placement: bring it back from off-screen, centered
				sw, sh := metric(0), metric(1)
				pSetWindowPos.Call(hwnd, 0,
					uintptr(int32(sw/2-int32(width)/2)), uintptr(int32(sh/2-int32(height)/2)),
					uintptr(width), uintptr(height), swpNoZorderNoActivate)
				pShowWindow.Call(hwnd, 5) // SW_SHOW
			}
			// claim foreground BEFORE destroying the splash: while the
			// splash (ours) is the foreground window, handing focus to
			// another window of the same process is always allowed.
			// Destroying it first hands foreground to some OTHER process,
			// and then this call is denied — the app stays buried.
			pSetForegroundWindow.Call(hwnd)
			splashGone()
		})
		// user-driven minimize/maximize should animate normally again
		time.Sleep(400 * time.Millisecond)
		w.Dispatch(func() {
			anim := int32(0)
			pDwmSetWindowAttribute.Call(hwnd, 3, uintptr(unsafe.Pointer(&anim)), 4)
		})
		go trackWindowBounds(hwnd, stop)
	}()
	w.Navigate(url)
	w.Run()
	return true
}

func openBrowser(url string) {
	exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
}
