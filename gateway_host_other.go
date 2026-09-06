//go:build !windows

package main

import (
	"os"
	"strings"
)

// osDNSSuffixes on Unix: the search domains from /etc/resolv.conf.
func osDNSSuffixes() []string {
	var out []string
	b, err := os.ReadFile("/etc/resolv.conf")
	if err != nil {
		return nil
	}
	for _, line := range strings.Split(string(b), "\n") {
		f := strings.Fields(line)
		if len(f) > 1 && (f[0] == "search" || f[0] == "domain") {
			out = append(out, f[1:]...)
		}
	}
	return out
}
