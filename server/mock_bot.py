"""Mock Extension Bot — simulates a Chrome Extension for E2E testing.

Connects to GAPI Server via WebSocket, listens for message_pending events,
and auto-responds with a mock AI reply via HTTP API.

Usage:
    python mock_bot.py [--url ws://localhost:18799] [--api-key gapi_...]
"""

import argparse
import asyncio
import json
import time
import secrets
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))

import websockets
from auth import generate_token

# Also use HTTP to post responses
import urllib.request


async def run_bot(ws_url: str, http_base: str, api_key: str):
    """Connect via WebSocket, listen for message_pending, reply via HTTP."""

    # Generate a token for WebSocket auth
    extension_id = f"mock_bot_{secrets.token_hex(4)}"
    timestamp = int(time.time() * 1000)
    token = generate_token(extension_id, timestamp)

    client_id = f"bot_{secrets.token_hex(4)}"
    uri = f"{ws_url}/ws/{client_id}"

    print(f"[Bot] Connecting to {uri}")
    print(f"[Bot] Extension ID: {extension_id}")
    print(f"[Bot] HTTP base: {http_base}")

    async with websockets.connect(uri) as ws:
        # Authenticate
        await ws.send(json.dumps({
            "type": "auth",
            "payload": {"token": token}
        }))

        auth_resp = json.loads(await ws.recv())
        if auth_resp.get("type") != "auth_ok":
            print(f"[Bot] Auth failed: {auth_resp}")
            return

        session_id = auth_resp["payload"]["session_id"]
        print(f"[Bot] Authenticated, session={session_id}")
        print(f"[Bot] Waiting for messages... (Ctrl+C to stop)\n")

        while True:
            data = json.loads(await ws.recv())
            msg_type = data.get("type")

            if msg_type == "pong":
                continue

            if msg_type == "message_pending":
                payload = data["payload"]
                conv_id = payload["conversation_id"]
                content = payload["content"]
                msg_id = payload["message_id"]

                print(f"[Bot] Received message_pending: conv={conv_id}")
                print(f"[Bot]   User said: {content}")

                # Simulate thinking delay
                await asyncio.sleep(1.5)

                # Generate mock AI response
                reply = generate_reply(content)
                print(f"[Bot]   Replying: {reply}")

                # Post response via HTTP API
                post_reply(http_base, api_key, conv_id, reply)
                print(f"[Bot]   Reply sent!\n")

            else:
                print(f"[Bot] Event: {msg_type}")


def generate_reply(user_message: str) -> str:
    """Generate a mock AI response based on user input."""
    msg = user_message.lower().strip()

    if "hello" in msg or "hi" in msg or "你好" in msg:
        return "你好！我是模擬的 AI 助手。有什麼可以幫你的嗎？"
    elif "test" in msg or "測試" in msg:
        return "收到測試訊息！Mock Bot 運作正常。這是一條自動回覆。"
    elif "?" in msg or "？" in msg:
        return "這是一個好問題！不過我只是測試用的 Mock Bot，無法給出真正的答案。"
    else:
        return f"[Mock AI] 已收到你的訊息：「{user_message[:50]}」。這是 Mock Bot 的自動回覆，用於驗證 E2E 資料流。"


def post_reply(http_base: str, api_key: str, conversation_id: str, content: str):
    """Post an AI response message via HTTP API."""
    url = f"{http_base}/v1/messages"
    data = json.dumps({
        "conversation_id": conversation_id,
        "content": content,
        "role": "model"
    }).encode("utf-8")

    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json"
        },
        method="POST"
    )

    try:
        with urllib.request.urlopen(req) as resp:
            result = json.loads(resp.read())
            return result
    except Exception as e:
        print(f"[Bot] HTTP error: {e}")
        return None


def main():
    parser = argparse.ArgumentParser(description="GAPI Mock Extension Bot")
    parser.add_argument("--ws-url", default="ws://localhost:18799",
                        help="WebSocket server URL (default: ws://localhost:18799)")
    parser.add_argument("--http-url", default="http://localhost:18799",
                        help="HTTP server URL (default: http://localhost:18799)")
    parser.add_argument("--api-key", required=True,
                        help="GAPI API key for posting replies")
    args = parser.parse_args()

    try:
        asyncio.run(run_bot(args.ws_url, args.http_url, args.api_key))
    except KeyboardInterrupt:
        print("\n[Bot] Shutting down.")


if __name__ == "__main__":
    main()
