#!/bin/bash
# Command Center — double-click launcher (macOS)
#
# Kills any previous server on :3333, (re)installs node_modules if missing,
# starts `npm run serve`, waits for readiness, opens the browser.
# Close the Terminal window or Ctrl-C to stop.

PROJECT_DIR="${COMMAND_CENTER_DIR:-$HOME/Desktop/claude-agent-lab}"
PORT="${PORT:-3333}"
URL="http://localhost:$PORT"

printf "\033]0;Command Center\a"  # Set Terminal window title

cat <<BANNER
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Command Center — launcher
  $PROJECT_DIR
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

BANNER

if [ ! -d "$PROJECT_DIR" ]; then
  echo "❌ Project folder not found at: $PROJECT_DIR"
  echo ""
  echo "Fix: set COMMAND_CENTER_DIR to the correct path, e.g."
  echo "  COMMAND_CENTER_DIR=/path/to/claude-agent-lab open 'Command Center.command'"
  echo ""
  read -r -p "Press Enter to close..." _
  exit 1
fi

cd "$PROJECT_DIR" || exit 1

# Stop any previous instance
if lsof -ti:"$PORT" > /dev/null 2>&1; then
  echo "🛑 Stopping existing server on :$PORT..."
  lsof -ti:"$PORT" | xargs kill -9 2>/dev/null
  sleep 1
fi

# Install deps on first run (or after a fresh clone)
if [ ! -d "node_modules" ]; then
  echo "📦 node_modules missing — running npm install..."
  npm install || {
    echo "❌ npm install failed"
    read -r -p "Press Enter to close..." _
    exit 1
  }
fi

# Start server in background, stream its output
echo "🚀 Starting Command Center on $URL"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

npm run serve &
SERVER_PID=$!

# Make sure we clean up if the Terminal window is closed or Ctrl-C is hit
cleanup() {
  echo ""
  echo "🛑 Stopping Command Center..."
  kill "$SERVER_PID" 2>/dev/null
  lsof -ti:"$PORT" | xargs kill -9 2>/dev/null
  exit 0
}
trap cleanup INT TERM HUP

# Poll until /api/cwd responds (up to ~10s)
printf "⏳ Waiting for server"
for _ in $(seq 1 30); do
  if curl -sf "$URL/api/cwd" > /dev/null 2>&1; then
    printf " — ready ✅\n"
    break
  fi
  printf "."
  sleep 0.33
done

# Open the browser
open "$URL"

cat <<READY

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Command Center is live at $URL
  Server logs below. Ctrl-C (or close this window) to stop.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

READY

# Block until the server exits so logs stream and Ctrl-C propagates
wait "$SERVER_PID"
