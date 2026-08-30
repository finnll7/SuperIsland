#!/bin/bash
# Panda Agent unified hook — reads the hook JSON on stdin, enriches it with
# session metadata (title from transcript, terminal from $TERM_PROGRAM), and
# POSTs it to the bridge. Panda supports a Claude Code-compatible hook format
# configured in ~/.panda/settings.json.
# Usage: panda-event-hook.sh <state>
#   state = Working | Waiting | Idle | Error | Auto
#   Auto  = PostToolUse — infer Working/Error from tool_response
# Always exits 0 so Panda is never blocked.

set -u
STATE="${1:-Working}"
PORT="${AGENTS_STATUS_PORT:-7823}"

find_agent_pid() {
  local pid=$PPID
  local max=6
  while [ "$max" -gt 0 ] && [ -n "$pid" ] && [ "$pid" -gt 1 ]; do
    local name
    name=$(ps -o comm= -p "$pid" 2>/dev/null)
    case "$name" in
      *panda*|*Panda*) echo "$pid"; return 0 ;;
    esac
    pid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
    max=$((max - 1))
  done
  return 1
}
AGENT_PID="$(find_agent_pid 2>/dev/null || true)"

# Drain stdin first — the heredoc below replaces stdin with the Python
# source code, so we can't let json.load(sys.stdin) compete with it.
HOOK_JSON=$(cat)

payload=$(
  STATE="$STATE" \
  HOOK_JSON="$HOOK_JSON" \
  TERM_PROGRAM="${TERM_PROGRAM:-}" \
  AGENT_PID="${AGENT_PID:-}" \
  /usr/bin/python3 - <<'PY' 2>/dev/null
import json, os, sys
try:
    d = json.loads(os.environ.get("HOOK_JSON") or "{}")
except Exception:
    d = {}

state = os.environ.get("STATE", "Working")
# Panda's hook JSON uses the same event vocabulary as Claude Code. Map the
# lifecycle to island states; tool-level failures keep the session Working
# (only CLI crashes / lost processes flip to Error, detected server-side).
if state == "Auto":
    state = "Working"
elif state == "ToolFail":
    if d.get("is_interrupt") is True:
        state = "Idle"
    else:
        state = "Working"
elif state == "Waiting":
    msg = (d.get("message") or "")
    if "permission" in msg.lower():
        state = "Waiting"
    else:
        state = "Idle"

session_id = d.get("session_id") or d.get("conversation_id") or "default"
cwd = d.get("cwd") or d.get("workspace") or ""
transcript = d.get("transcript_path") or ""

# Title: newest user-authored message in the transcript (plain-string content).
title = ""
if transcript and os.path.exists(transcript):
    try:
        with open(transcript, "r", encoding="utf-8", errors="replace") as f:
            lines = f.readlines()
        for line in reversed(lines):
            line = line.strip()
            if not line:
                continue
            try:
                m = json.loads(line)
            except Exception:
                continue
            if m.get("type") != "user":
                continue
            msg = m.get("message") or {}
            content = msg.get("content")
            if isinstance(content, str) and content.strip():
                title = content.strip()
                break
    except Exception:
        pass

# Fallback: UserPromptSubmit carries the prompt directly.
if not title and d.get("hook_event_name") == "UserPromptSubmit":
    p = d.get("prompt")
    if isinstance(p, str) and p.strip():
        title = p.strip()

# Panda task name: read the conversation title from panda's catalog DB so the
# island shows the same task name as the Panda app. session_id here is the
# panda conversation_id.
if not title and session_id:
    catalog = os.path.expanduser("~/.panda/desktop/catalog.db")
    if os.path.exists(catalog):
        try:
            import sqlite3
            conn = sqlite3.connect("file:%s?mode=ro" % catalog, uri=True)
            row = conn.execute(
                "SELECT title FROM conversation_summaries "
                "WHERE conversation_id=? AND title != '' "
                "ORDER BY updated_at DESC LIMIT 1",
                (session_id,),
            ).fetchone()
            if row and row[0]:
                title = row[0]
            conn.close()
        except Exception:
            pass

title = title[:120]

term_map = {
    "iTerm.app": "iTerm",
    "Apple_Terminal": "Terminal",
    "vscode": "VS Code",
    "WarpTerminal": "Warp",
    "ghostty": "Ghostty",
    "Hyper": "Hyper",
    "WezTerm": "WezTerm",
    "kitty": "kitty",
    "tabby": "Tabby",
    "alacritty": "Alacritty",
}
raw_term = os.environ.get("TERM_PROGRAM") or ""
term = term_map.get(raw_term, raw_term)

try:
    pid = int(os.environ.get("AGENT_PID") or 0) or None
except Exception:
    pid = None

sys.stdout.write(json.dumps({
    "state": state,
    "agent": "Panda",
    "session_id": session_id,
    "cwd": cwd,
    "title": title,
    "terminal": term,
    "pid": pid,
    "transcript_path": transcript,
}))
PY
)

if [ -z "${payload:-}" ]; then
  payload="{\"state\":\"${STATE}\",\"agent\":\"panda\"}"
fi

# SessionEnd: Panda is quitting, so run curl synchronously — a
# backgrounded child would get killed with the parent before it lands.
if [ "$STATE" = "Ended" ]; then
  curl -s -m 2 -X POST "http://127.0.0.1:${PORT}/event" \
    -H 'Content-Type: application/json' \
    --data-raw "$payload" >/dev/null 2>&1
else
  curl -s -m 1 -X POST "http://127.0.0.1:${PORT}/event" \
    -H 'Content-Type: application/json' \
    --data-raw "$payload" >/dev/null 2>&1 &
fi

exit 0