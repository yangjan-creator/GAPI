import { useCallback, useEffect, useRef, useState } from 'react';
import type { ActivePage } from '../types';

const RECONNECT_DELAY_MS = 5_000;
const AUTH_TIMEOUT_MS = 10_000;

interface PagesUpdatePayload {
  pages: ActivePage[];
  meta?: { total: number; connected_extensions: number };
}

export interface UseWebSocketOptions {
  serverUrl: string;
  onPagesUpdate?: (pages: ActivePage[], meta?: PagesUpdatePayload['meta']) => void;
  onConnected?: () => void;
  onDisconnected?: () => void;
}

export interface UseWebSocketResult {
  connected: boolean;
  send: (data: unknown) => void;
  disconnect: () => void;
}

function httpToWs(url: string): string {
  return url.replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://');
}

/**
 * Reusable WebSocket hook for connecting to the GAPI server.
 *
 * Handles: auth token acquisition, WS auth handshake,
 * pages_update message dispatch, and auto-reconnect on disconnect.
 */
export function useWebSocket(options: UseWebSocketOptions): UseWebSocketResult {
  const { serverUrl, onPagesUpdate, onConnected, onDisconnected } = options;

  const [connected, setConnected] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const unmountedRef = useRef(false);

  // Keep latest callbacks in refs to avoid re-triggering the effect
  const onPagesUpdateRef = useRef(onPagesUpdate);
  onPagesUpdateRef.current = onPagesUpdate;
  const onConnectedRef = useRef(onConnected);
  onConnectedRef.current = onConnected;
  const onDisconnectedRef = useRef(onDisconnected);
  onDisconnectedRef.current = onDisconnected;

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const closeWs = useCallback(() => {
    clearReconnectTimer();
    const ws = wsRef.current;
    if (ws) {
      wsRef.current = null;
      ws.onopen = null;
      ws.onclose = null;
      ws.onmessage = null;
      ws.onerror = null;
      try {
        ws.close(1000, 'Client disconnect');
      } catch {
        // already closed
      }
    }
    setConnected(false);
  }, [clearReconnectTimer]);

  const connect = useCallback(async () => {
    if (unmountedRef.current) return;
    closeWs();

    // Step 1: Obtain auth token via REST
    let token: string;
    try {
      const clientId = `admin-web-${Date.now()}`;
      const response = await fetch(
        `${serverUrl}/v1/auth/token?extension_id=admin-web`,
        { method: 'POST' },
      );
      if (!response.ok) {
        throw new Error(`Token request failed: HTTP ${response.status}`);
      }
      const data = await response.json();
      token = data.token;
      if (!token) {
        throw new Error('Empty token in response');
      }

      // Step 2: Open WebSocket
      if (unmountedRef.current) return;

      const wsUrl = `${httpToWs(serverUrl)}/ws/${clientId}`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        // Send auth message immediately
        ws.send(JSON.stringify({
          type: 'auth',
          payload: { token },
        }));

        // Set a timeout for auth response
        const authTimeout = window.setTimeout(() => {
          if (wsRef.current === ws && !unmountedRef.current) {
            ws.close(1008, 'Auth timeout');
          }
        }, AUTH_TIMEOUT_MS);

        // Patch the message handler to intercept auth_ok
        const origOnMessage = ws.onmessage;
        ws.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data);
            if (msg.type === 'auth_ok') {
              window.clearTimeout(authTimeout);
              setConnected(true);
              onConnectedRef.current?.();
              // Switch to the main message handler
              ws.onmessage = handleMessage;
              return;
            }
            if (msg.type === 'auth_error') {
              window.clearTimeout(authTimeout);
              ws.close(1008, 'Auth failed');
              return;
            }
          } catch {
            // ignore parse errors during auth phase
          }
          origOnMessage?.call(ws, event);
        };
      };

      ws.onerror = () => {
        // onerror is always followed by onclose, so just let onclose handle reconnection
      };

      ws.onclose = () => {
        const wasConnected = wsRef.current === ws;
        if (wasConnected) {
          wsRef.current = null;
          setConnected(false);
          onDisconnectedRef.current?.();
        }
        // Schedule reconnect if still mounted
        if (!unmountedRef.current) {
          reconnectTimerRef.current = window.setTimeout(() => {
            reconnectTimerRef.current = null;
            connect();
          }, RECONNECT_DELAY_MS);
        }
      };
    } catch {
      // Token fetch or other error -- schedule reconnect
      if (!unmountedRef.current) {
        reconnectTimerRef.current = window.setTimeout(() => {
          reconnectTimerRef.current = null;
          connect();
        }, RECONNECT_DELAY_MS);
      }
    }

    function handleMessage(event: MessageEvent) {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'pages_update') {
          const payload = msg.payload as PagesUpdatePayload;
          onPagesUpdateRef.current?.(payload.pages ?? [], payload.meta);
        }
        // Other message types can be handled here in the future
      } catch {
        // ignore malformed messages
      }
    }
  }, [serverUrl, closeWs]);

  // Connect on mount or when serverUrl changes
  useEffect(() => {
    unmountedRef.current = false;
    connect();
    return () => {
      unmountedRef.current = true;
      closeWs();
    };
  }, [connect, closeWs]);

  const send = useCallback((data: unknown) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(typeof data === 'string' ? data : JSON.stringify(data));
    }
  }, []);

  const disconnect = useCallback(() => {
    unmountedRef.current = true;
    closeWs();
  }, [closeWs]);

  return { connected, send, disconnect };
}
