package main

// Windows blocks inbound connections per network profile, and the one-time
// "allow access" dialog usually gets answered for a single profile. A
// gateway that listens correctly on a name the phone resolves still goes
// nowhere when the allow rule covers Public while the Wi-Fi is Private —
// silently, which is the worst way for sharing to fail. So we ask the
// firewall whether anything would let our own binary in on the profile the
// active networks actually use, and say so in the Sharing panel.

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

var pShellExecuteW = shell32dlg.NewProc("ShellExecuteW")

// shellRunAs runs a program elevated: the "runas" verb makes Windows show
// the consent prompt, and a refusal comes back as an error rather than a
// silent no-op. SW_HIDE keeps netsh's console from flashing.
func shellRunAs(exe, args string) error {
	verb, _ := syscall.UTF16PtrFromString("runas")
	file, err := syscall.UTF16PtrFromString(exe)
	if err != nil {
		return err
	}
	par, err := syscall.UTF16PtrFromString(args)
	if err != nil {
		return err
	}
	r, _, callErr := pShellExecuteW.Call(0,
		uintptr(unsafe.Pointer(verb)), uintptr(unsafe.Pointer(file)),
		uintptr(unsafe.Pointer(par)), 0, 0 /* SW_HIDE */)
	// ShellExecuteW returns >32 on success; 1223 is ERROR_CANCELLED (declined)
	if r <= 32 {
		if r == 1223 {
			return fmt.Errorf("the elevation prompt was declined")
		}
		return fmt.Errorf("could not run %s elevated (code %d): %v", exe, r, callErr)
	}
	return nil
}

type firewallState struct {
	Allowed  bool   `json:"allowed"`
	Profiles string `json:"profiles"` // the active networks' categories
	Pending  bool   `json:"-"`        // no answer yet; ask again in a moment
	checked  bool
}

var (
	fwMu      sync.Mutex
	fwLast    firewallState
	fwAt      time.Time
	fwRunning bool
)

// the rules are read through PowerShell: the cmdlets speak a stable object
// shape, while netsh output is localized and unparsable on a Dutch machine
const fwScript = `
$ErrorActionPreference = 'SilentlyContinue'
$want = @()
foreach ($c in @(Get-NetConnectionProfile | ForEach-Object { "$($_.NetworkCategory)" })) {
  if ($c -eq 'DomainAuthenticated') { $want += 'Domain' } elseif ($c) { $want += $c }
}
$exe = $env:REMARK_FW_EXE
$port = $env:REMARK_FW_PORT
$covers = {
  param($p)
  if (-not $p) { return $false }
  if ($p -match 'Any') { return $true }
  foreach ($w in $want) { if ($p -match $w) { return $true } }
  return $false
}
$allowed = $false
$rules = @(Get-NetFirewallRule -Direction Inbound -Enabled True -Action Allow)
$byName = @{}
foreach ($r in $rules) { $byName[$r.Name] = $r }
foreach ($f in @(Get-NetFirewallApplicationFilter)) {
  if (-not $f.Program) { continue }
  if ($f.Program.ToLower() -ne $exe.ToLower()) { continue }
  $r = $byName[$f.InstanceID]
  if ($r -and (& $covers "$($r.Profile)")) { $allowed = $true; break }
}
if (-not $allowed -and $port) {
  foreach ($f in @(Get-NetFirewallPortFilter)) {
    if ($f.Protocol -ne 'TCP') { continue }
    if (-not ($f.LocalPort -contains $port -or "$($f.LocalPort)" -eq $port)) { continue }
    $r = $byName[$f.InstanceID]
    if ($r -and (& $covers "$($r.Profile)")) { $allowed = $true; break }
  }
}
[pscustomobject]@{ allowed = [bool]$allowed; profiles = ($want -join ',') } | ConvertTo-Json -Compress
`

// firewallAllowsInbound answers whether our binary may accept connections on
// the active network profiles. Reading the rules costs seconds, so the answer
// is cached and refreshed in the background: a caller gets what is known now
// (Pending until the first answer lands) and never waits on PowerShell.
func firewallAllowsInbound(port int) firewallState {
	fwMu.Lock()
	fresh := fwLast.checked && time.Since(fwAt) < 30*time.Second
	st := fwLast
	if !fresh && !fwRunning {
		fwRunning = true
		go func() {
			s := firewallProbe(port)
			fwMu.Lock()
			fwLast, fwAt, fwRunning = s, time.Now(), false
			fwMu.Unlock()
		}()
	}
	fwMu.Unlock()
	if !st.checked {
		return firewallState{Allowed: true, Pending: true} // unknown: never cry wolf
	}
	return st
}

// firewallInvalidate drops the cached verdict, so the next call re-reads the
// rules — used right after we have changed them.
func firewallInvalidate() {
	fwMu.Lock()
	fwLast, fwAt = firewallState{}, time.Time{}
	fwMu.Unlock()
}

func firewallProbe(port int) firewallState {
	exe, err := os.Executable()
	if err != nil {
		return firewallState{Allowed: true, checked: true} // cannot tell
	}
	cmd := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", fwScript)
	cmd.Env = append(os.Environ(),
		"REMARK_FW_EXE="+exe,
		"REMARK_FW_PORT="+strconv.Itoa(port))
	out, err := cmd.Output()
	st := firewallState{Allowed: true, checked: true}
	if err == nil {
		var got firewallState
		if json.Unmarshal([]byte(strings.TrimSpace(string(out))), &got) == nil {
			got.checked = true
			st = got
		}
	}
	return st
}

// firewallRequestAllow asks Windows for consent once (the UAC prompt) and
// writes the inbound rule itself. The old "allow access" alert cannot be
// summoned — Windows raises it only for a program it has no rule for, and
// remark usually has one for the wrong profile — so one elevation prompt is
// the closest honest equivalent. netsh does the writing: it needs no
// PowerShell policy and speaks the same words on every locale.
func firewallRequestAllow(port int) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	args := `advfirewall firewall add rule name="remark gateway" dir=in action=allow ` +
		`program="` + exe + `" enable=yes profile=private,domain protocol=TCP`
	if err := shellRunAs("netsh.exe", args); err != nil {
		return err
	}
	firewallInvalidate()
	return nil
}

// firewallFixCommand is what the human runs in an elevated shell. Widening
// the rules remark already has is gentler than adding another one.
func firewallFixCommand() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	return "New-NetFirewallRule -DisplayName 'remark gateway' -Direction Inbound " +
		"-Action Allow -Protocol TCP -Program '" + exe + "' -Profile Private,Domain"
}
