//go:build !windows

package main

// Only Windows keeps a per-network-profile allow list that a listening
// program can silently fall outside of; elsewhere sharing either binds or
// does not. The surface mirrors firewall_windows.go so callers and tests
// compile everywhere.

type firewallState struct {
	Allowed  bool   `json:"allowed"`
	Profiles string `json:"profiles"`
	Pending  bool   `json:"-"`
	checked  bool
}

func firewallAllowsInbound(int) firewallState {
	return firewallState{Allowed: true, checked: true}
}
func firewallProbe(int) firewallState {
	return firewallState{Allowed: true, checked: true}
}
func firewallInvalidate()         {}
func firewallFixCommand() string  { return "" }
func firewallRequestAllow() error { return errNoFirewallUI }

var errNoFirewallUI = errorString("this platform has no per-profile firewall prompt")

type errorString string

func (e errorString) Error() string { return string(e) }
