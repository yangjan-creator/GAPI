#!/bin/bash

GAPI_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$GAPI_DIR/server/.gapi.pid"

if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE")
    if kill -0 "$PID" 2>/dev/null; then
        kill "$PID"
        rm -f "$PID_FILE"
        echo "[OK] GAPI Server stopped (PID: $PID)"
    else
        rm -f "$PID_FILE"
        echo "[INFO] Server was not running. Cleaned up stale PID file."
    fi
else
    echo "[INFO] No running server found."
fi
