//go:build !windows

package main

// Only Windows blocks a listening program per network profile behind a
// one-time dialog; elsewhere sharing either binds or does not.

type firewallState struct {
	Allowed  bool   `json:"allowed"`
	Profiles string `json:"profiles"`
}

func firewallAllowsInbound(int) firewallState { return firewallState{Allowed: true} }
func firewallFixCommand() string              { return "" }
func firewallRequestAllow(int) error          { return errNoFirewallUI }
func firewallInvalidate()                     {}

var errNoFirewallUI = errorString("this platform has no per-profile firewall prompt")

type errorString string

func (e errorString) Error() string { return string(e) }
