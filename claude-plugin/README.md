# remark — Claude Code plugin

One guard, and nothing else.

`remark monitor` is a stream: it prints a line per comment for as long as it
runs. Started from an ordinary shell call it is killed when that call times
out, or its output is held until it dies — either way the comments never
reach the agent, and nothing about the failure is visible from the outside. A
monitor that says `watching 1 file(s)` and then nothing looks exactly like a
monitor with nothing to report.

This plugin catches that before it happens. A `PreToolUse` hook on the Bash
tool asks `remark hook claude` whether the command is a monitor launch; if it
is, the call is denied with an explanation pointing at the streaming tool.

## What it does not do

**It starts nothing.** Installing it does not begin watching any document.
Which document an agent follows, under which name, and in which threads is a
decision for the person running it — an agent should never be drawn into a
conversation by the mere fact of being installed.

## Install

Requires `remark` on the PATH (`remark install`).

Locally, for a session:

```
claude --plugin-dir /path/to/remark/claude-plugin
```

## What gets blocked

Denied — these would never deliver:

```
remark monitor discussion.md -as Claude
"C:\Users\you\AppData\Local\Programs\remark\remark.exe" monitor D:/p/TODO.md -as Bot -mine
cd /project && remark monitor notes.md
```

Allowed — none of these launch a monitor:

```
remark help monitor
remark read notes.md
echo "remark monitor notes.md"
grep -r "remark monitor" docs/
remark query notes.md -text "remark monitor"
```

To run one from a shell deliberately, include `REMARK_HOOK_OK` in the command.

The matching lives in `remark hook claude`, not in this file, so it can be
tested and corrected without anyone editing JSON. Its decision table is in
`hook_test.go`.
