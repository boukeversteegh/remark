//go:build windows

package main

import (
	"strings"

	"golang.org/x/sys/windows/registry"
)

// osDNSSuffixes lists the DNS suffixes Windows knows for this machine: the
// primary/NV domain and every adapter's DHCP-supplied or configured
// suffix (a home router hands out ".home"). The gateway tries them in
// order and keeps the first name that resolves back to itself.
func osDNSSuffixes() []string {
	var out []string
	seen := map[string]bool{}
	add := func(s string) {
		s = strings.TrimSpace(strings.TrimSuffix(s, "."))
		if s != "" && !seen[strings.ToLower(s)] {
			seen[strings.ToLower(s)] = true
			out = append(out, s)
		}
	}
	const params = `SYSTEM\CurrentControlSet\Services\Tcpip\Parameters`
	if k, err := registry.OpenKey(registry.LOCAL_MACHINE, params, registry.QUERY_VALUE); err == nil {
		for _, name := range []string{"Domain", "NV Domain", "DhcpDomain", "SearchList"} {
			if v, _, err := k.GetStringValue(name); err == nil {
				for _, part := range strings.Split(v, ",") {
					add(part)
				}
			}
		}
		k.Close()
	}
	if k, err := registry.OpenKey(registry.LOCAL_MACHINE, params+`\Interfaces`, registry.ENUMERATE_SUB_KEYS); err == nil {
		subs, _ := k.ReadSubKeyNames(-1)
		k.Close()
		for _, sub := range subs {
			if ik, err := registry.OpenKey(registry.LOCAL_MACHINE, params+`\Interfaces\`+sub, registry.QUERY_VALUE); err == nil {
				for _, name := range []string{"DhcpDomain", "Domain"} {
					if v, _, err := ik.GetStringValue(name); err == nil {
						add(v)
					}
				}
				ik.Close()
			}
		}
	}
	return out
}
