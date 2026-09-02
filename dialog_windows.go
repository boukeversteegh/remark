//go:build windows

package main

import (
	"runtime"
	"syscall"
	"unsafe"
)

var (
	comdlg32          = syscall.NewLazyDLL("comdlg32.dll")
	pGetOpenFileNameW = comdlg32.NewProc("GetOpenFileNameW")
)

type openFileNameW struct {
	lStructSize       uint32
	hwndOwner         uintptr
	hInstance         uintptr
	lpstrFilter       *uint16
	lpstrCustomFilter *uint16
	nMaxCustFilter    uint32
	nFilterIndex      uint32
	lpstrFile         *uint16
	nMaxFile          uint32
	lpstrFileTitle    *uint16
	nMaxFileTitle     uint32
	lpstrInitialDir   *uint16
	lpstrTitle        *uint16
	flags             uint32
	nFileOffset       uint16
	nFileExtension    uint16
	lpstrDefExt       *uint16
	lCustData         uintptr
	lpfnHook          uintptr
	lpTemplateName    *uint16
	pvReserved        uintptr
	dwReserved        uint32
	flagsEx           uint32
}

const (
	ofnFileMustExist = 0x00001000
	ofnPathMustExist = 0x00000800
	ofnExplorer      = 0x00080000
	ofnNoChangeDir   = 0x00000008
)

func utf16Filter(pairs []string) *uint16 {
	var buf []uint16
	for _, s := range pairs {
		buf = append(buf, syscall.StringToUTF16(s)...)
	}
	buf = append(buf, 0)
	return &buf[0]
}

// pickFile shows the native Open dialog and returns the chosen path, or ""
// if the user cancelled.
func pickFile(initialDir string) string {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	file := make([]uint16, 32768)
	ofn := openFileNameW{
		lpstrFilter: utf16Filter([]string{
			"Markdown files (*.md)", "*.md;*.markdown;*.mdown",
			"All files (*.*)", "*.*",
		}),
		nFilterIndex: 1,
		lpstrFile:    &file[0],
		nMaxFile:     uint32(len(file)),
		lpstrTitle:   syscall.StringToUTF16Ptr("Open markdown file"),
		flags:        ofnFileMustExist | ofnPathMustExist | ofnExplorer | ofnNoChangeDir,
	}
	ofn.lStructSize = uint32(unsafe.Sizeof(ofn))
	if initialDir != "" {
		ofn.lpstrInitialDir = syscall.StringToUTF16Ptr(initialDir)
	}
	ret, _, _ := pGetOpenFileNameW.Call(uintptr(unsafe.Pointer(&ofn)))
	if ret == 0 {
		return ""
	}
	return syscall.UTF16ToString(file)
}
