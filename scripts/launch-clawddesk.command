#!/bin/bash
# ClawdDesk — double-click launcher (macOS)
#
# Flow:
#   1. Kill any prior instance, both by command-pattern AND by port :3333
#   2. Wait until port is actually free (retry kill up to 6 times)
#   3. Start `npm run serve` writing to /tmp/clawddesk-<port>.log
#   4. Poll /api/cwd for up to ~15s until it responds
#   5. Open the browser ONLY after readiness is confirmed
#   6. Tail the log in this window; Ctrl-C or close cleans up everything
#
# Any failure at an earlier step shows the error and pauses before
# exiting, so you can read the Terminal window instead of staring at
# "localhost refused to connect" in the browser.

PORT="${PORT:-3333}"
URL="http://localhost:$PORT"
LOG="/tmp/clawddesk-$PORT.log"

# -----------------------------------------------------------------------------
# Resolve the project folder. Preference order:
#   1. CLAWDDESK_DIR env var (explicit override)
#   2. Parent of this script (works when the launcher lives in the repo's
#      own scripts/ folder — auto-follows the project wherever it moves)
#   3. Common locations on disk (for the standalone Desktop copy)
# -----------------------------------------------------------------------------
is_lab_dir() {
  [ -f "$1/package.json" ] && grep -q '"clawddesk"' "$1/package.json" 2>/dev/null
}

PROJECT_DIR=""

if [ -n "${CLAWDDESK_DIR:-}" ]; then
  PROJECT_DIR="$CLAWDDESK_DIR"
else
  # Option 2 — if this script is inside "<project>/scripts/", its parent IS the project
  SCRIPT_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if is_lab_dir "$(cd "$SCRIPT_PATH/.." 2>/dev/null && pwd)"; then
    PROJECT_DIR="$(cd "$SCRIPT_PATH/.." && pwd)"
  fi

  # Option 3 — search common parents
  if [ -z "$PROJECT_DIR" ]; then
    for candidate in \
      "$HOME/Documents/projects/clawddesk" \
      "$HOME/Documents/clawddesk" \
      "$HOME/Projects/clawddesk" \
      "$HOME/projects/clawddesk" \
      "$HOME/code/clawddesk" \
      "$HOME/src/clawddesk" \
      "$HOME/Desktop/clawddesk"; do
      if is_lab_dir "$candidate"; then
        PROJECT_DIR="$candidate"
        break
      fi
    done
  fi
fi

printf "\033]0;ClawdDesk\a"  # Terminal title

cat <<BANNER
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ClawdDesk — launcher
  $PROJECT_DIR
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

BANNER

pause_and_exit() {
  local code="${1:-1}"
  echo ""
  read -r -p "Press Enter to close this window..." _ || true
  exit "$code"
}

if [ -z "$PROJECT_DIR" ] || [ ! -d "$PROJECT_DIR" ]; then
  echo "❌ Could not find the clawddesk project folder."
  echo ""
  echo "Searched:"
  echo "  \$CLAWDDESK_DIR env var — ${CLAWDDESK_DIR:-(not set)}"
  echo "  ~/Documents/projects/clawddesk"
  echo "  ~/Documents/clawddesk"
  echo "  ~/Projects/clawddesk"
  echo "  ~/projects/clawddesk"
  echo "  ~/code/clawddesk"
  echo "  ~/src/clawddesk"
  echo "  ~/Desktop/clawddesk"
  echo ""
  echo "Fix: set the env var before launching, e.g."
  echo "  CLAWDDESK_DIR=/full/path/to/clawddesk \\"
  echo "    open 'ClawdDesk.command'"
  echo ""
  echo "Or edit the candidate list near the top of this file."
  pause_and_exit 1
fi

cd "$PROJECT_DIR" || pause_and_exit 1

# -----------------------------------------------------------------------------
# Step 1 & 2 — aggressive kill of prior instance, then wait for port to free
# -----------------------------------------------------------------------------
echo "🛑 Clearing any previous ClawdDesk server..."

# Match the tsx process by its full command line. npm wraps tsx, so killing
# npm's PID alone is unreliable. These patterns catch the child directly.
pkill -f "clawddesk.*src/server.ts" 2>/dev/null
pkill -f "tsx[^a-z].*src/server\.ts" 2>/dev/null

# Also kill whatever's currently holding the port, retrying up to 6 times
# because occasionally macOS takes ~half a second to release the socket.
for attempt in 1 2 3 4 5 6; do
  if ! lsof -ti:"$PORT" > /dev/null 2>&1; then
    break
  fi
  [ "$attempt" -gt 1 ] && echo "  (retry $attempt) still held, force-killing…"
  lsof -ti:"$PORT" | xargs kill -9 2>/dev/null
  sleep 0.4
done

if lsof -ti:"$PORT" > /dev/null 2>&1; then
  holder=$(lsof -ti:"$PORT" | head -1)
  proc=$(ps -p "$holder" -o command= 2>/dev/null | head -c 120)
  echo ""
  echo "❌ Port $PORT is still held after 6 kill attempts."
  echo "   PID: $holder"
  echo "   Command: $proc"
  echo ""
  echo "   This isn't ClawdDesk. Kill it manually:"
  echo "     lsof -i :$PORT          # find the culprit"
  echo "     kill -9 $holder         # stop it"
  pause_and_exit 1
fi

echo "  ✅ Port $PORT is free."
echo ""

# -----------------------------------------------------------------------------
# Step 3 — install deps on first run, then start the server
# -----------------------------------------------------------------------------
if [ ! -d "node_modules" ]; then
  echo "📦 node_modules missing — running npm install..."
  if ! npm install; then
    echo "❌ npm install failed. Scroll up for the error."
    pause_and_exit 1
  fi
  echo ""
fi

echo "🚀 Starting ClawdDesk on $URL..."
: > "$LOG"   # truncate log so we only see THIS run's output
npm run serve > "$LOG" 2>&1 &
SERVER_PID=$!

# -----------------------------------------------------------------------------
# Cleanup trap — set AFTER the server is spawned so early-exit paths above
# don't try to kill a PID that doesn't exist yet.
# -----------------------------------------------------------------------------
cleanup() {
  echo ""
  echo "🛑 Stopping ClawdDesk..."
  # Kill the tail first so it doesn't keep the Terminal busy
  [ -n "${TAIL_PID:-}" ] && kill "$TAIL_PID" 2>/dev/null
  # Kill the server tree by pattern (reliable) and by port (belt-and-suspenders)
  pkill -f "clawddesk.*src/server.ts" 2>/dev/null
  pkill -f "tsx[^a-z].*src/server\.ts" 2>/dev/null
  lsof -ti:"$PORT" | xargs kill -9 2>/dev/null
  exit 0
}
trap cleanup INT TERM HUP

# -----------------------------------------------------------------------------
# Step 4 — poll until /api/cwd responds (max ~15 s) OR the server exits early
# -----------------------------------------------------------------------------
printf "⏳ Waiting for server to be ready"
READY=0
for _ in $(seq 1 45); do
  if curl -sf "$URL/api/cwd" > /dev/null 2>&1; then
    printf " — ready ✅\n"
    READY=1
    break
  fi
  # If npm already crashed, stop polling and show the log
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    printf " — server exited early ❌\n"
    break
  fi
  printf "."
  sleep 0.33
done

if [ "$READY" -ne 1 ]; then
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "❌ Server didn't become reachable in 15 s."
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""
  echo "Last 40 lines of the server log:"
  echo ""
  tail -40 "$LOG"
  echo ""
  echo "Full log: $LOG"
  # Don't open the browser — that's what causes the "localhost refused to
  # connect" you were seeing earlier.
  pause_and_exit 1
fi

# -----------------------------------------------------------------------------
# Step 5 — open browser now that we know the server is answering
# -----------------------------------------------------------------------------
open "$URL"

cat <<READY

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ✅ ClawdDesk is live at $URL
  Server logs streaming below. Ctrl-C (or close this window) to stop.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

READY

# -----------------------------------------------------------------------------
# Step 6 — tail the log so you can see server output in real time, and wait
# on the server PID so Ctrl-C propagates through `wait`.
# -----------------------------------------------------------------------------
tail -f "$LOG" &
TAIL_PID=$!

wait "$SERVER_PID" 2>/dev/null

# Server exited on its own (not via trap). Stop the tail, then exit cleanly.
kill "$TAIL_PID" 2>/dev/null
echo ""
echo "ℹ️  Server exited. Press Enter to close this window, or run the launcher again."
read -r _ || true
