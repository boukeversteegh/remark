package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The "what's new since last time" list and the record of having shown it must
// not race: reading and acking in one call is what keeps entries from
// disappearing between the two.
func TestChangelogUnseenThenAck(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("APPDATA", dir)
	t.Setenv("XDG_CONFIG_HOME", dir)
	t.Setenv("HOME", dir)

	first := changelogUnseen()
	if len(first) == 0 {
		t.Fatal("a machine that never showed a changelog should get this build's entries")
	}
	// acking AFTER reading is the order the server now uses
	changelogAck()
	if again := changelogUnseen(); len(again) != 0 {
		t.Errorf("after acking, nothing is unseen; got %d entries", len(again))
	}
	// the reverse order is the bug: ack first and the read comes back empty,
	// so the panel would open with nothing in it
	os.Remove(changelogLastPath())
	changelogAck()
	if entries := changelogUnseen(); len(entries) != 0 {
		t.Errorf("sanity: acking first must empty the list (that was the race): %d", len(entries))
	}
}

// "Restart all" is a mark on disk that every window sees on its own poll: no
// window needs another's port or token.
func TestRestartAllMark(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("APPDATA", dir)
	t.Setenv("XDG_CONFIG_HOME", dir)
	t.Setenv("HOME", dir)

	started := time.Now()
	if restartAllPending(started) {
		t.Fatal("nothing has been asked for yet")
	}
	time.Sleep(10 * time.Millisecond)
	if err := restartAllRequest(); err != nil {
		t.Fatal(err)
	}
	if !restartAllPending(started) {
		t.Error("a window started before the request must act on it")
	}
	// a window opened AFTER the request already runs the new build
	if restartAllPending(time.Now().Add(time.Second)) {
		t.Error("a window started after the request must ignore it")
	}
	// the mark lives in the config dir, beside the other per-machine state
	if !strings.HasPrefix(changelogRestartPath(), filepath.Dir(prefsPath())) {
		t.Errorf("unexpected location: %s", changelogRestartPath())
	}
}
