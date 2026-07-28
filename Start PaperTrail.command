#!/bin/bash
# Double-click this file to launch the PaperTrail dashboard.
# It starts the local server and opens the dashboard in your browser.
# Leave this Terminal window open while you use it; close it (or press Ctrl+C) to stop.

cd "$(dirname "$0")" || exit 1

# If a previous instance is still running on port 4000, stop it first so
# restarting always works (avoids "address already in use").
EXISTING=$(lsof -ti tcp:4000 2>/dev/null)
if [ -n "$EXISTING" ]; then
  echo "Stopping a previous instance on port 4000…"
  echo "$EXISTING" | xargs kill -9 2>/dev/null
  sleep 1
fi

echo "Starting PaperTrail…"
# Open the browser a moment after the server boots.
( sleep 2 && open "http://localhost:4000" ) &

# Run the server in this window (keeps it alive).
npm start
