#!/bin/bash
set -e

GAPI_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVER_DIR="$GAPI_DIR/server"

echo "=== GAPI Server ==="
echo ""

# 1. Check Python 3
if ! command -v python3 &>/dev/null; then
    echo "[ERROR] python3 not found. Please install Python 3.10+."
    exit 1
fi

# 2. Check if already running
if [ -f "$SERVER_DIR/.gapi.pid" ]; then
    OLD_PID=$(cat "$SERVER_DIR/.gapi.pid")
    if kill -0 "$OLD_PID" 2>/dev/null; then
        echo "[INFO] GAPI Server already running (PID: $OLD_PID)"
        echo "  Stop it first: bash stop.sh"
        exit 0
    else
        rm -f "$SERVER_DIR/.gapi.pid"
    fi
fi

# 3. Create venv if needed
if [ ! -d "$SERVER_DIR/venv" ]; then
    echo "[SETUP] Creating virtual environment..."
    python3 -m venv "$SERVER_DIR/venv"
fi

# 4. Install dependencies
echo "[SETUP] Checking dependencies..."
"$SERVER_DIR/venv/bin/pip" install -q -r "$SERVER_DIR/requirements.txt"

# 5. Create .env from .env.example if missing
if [ ! -f "$SERVER_DIR/.env" ]; then
    echo "[SETUP] Creating .env from .env.example..."
    cp "$SERVER_DIR/.env.example" "$SERVER_DIR/.env"
    # Fix Windows line endings if present
    sed -i 's/\r$//' "$SERVER_DIR/.env"
    SECRET=$(python3 -c "import secrets; print(secrets.token_hex(32))")
    sed -i "s/your_secret_key_here/$SECRET/" "$SERVER_DIR/.env"
    echo "[SETUP] Generated GAPI_AUTH_SECRET automatically."
fi

# 6. Load .env (strip carriage returns for WSL compatibility)
set -a
eval "$(sed 's/\r$//' "$SERVER_DIR/.env" | grep -v '^#' | grep -v '^$')"
set +a

# 7. Start server
cd "$SERVER_DIR"
./venv/bin/python3 mcp_server.py &
SERVER_PID=$!

# Wait briefly and check if process is alive
sleep 2
if kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "$SERVER_PID" > .gapi.pid
    echo ""
    echo "[OK] GAPI Server started (PID: $SERVER_PID)"
    echo "  API:  http://localhost:18799"
    echo "  Docs: http://localhost:18799/docs"
    echo ""
    echo "  Stop: bash $GAPI_DIR/stop.sh"
else
    echo "[ERROR] Server failed to start. Check logs above."
    exit 1
fi
