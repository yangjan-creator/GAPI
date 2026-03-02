import React, { useEffect, useState } from 'react';
import type { Message } from '../types';
import type { GapiClient } from '../client';

function formatTime(ts?: number) {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleString('zh-TW', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return '';
  }
}

interface MessageBubbleProps {
  msg: Message;
  client: GapiClient;
}

export function MessageBubble({ msg, client }: MessageBubbleProps) {
  const role = msg.role || 'unknown';
  const isUser = role === 'user';
  const isAssistant = role === 'assistant' || role === 'model';

  const rowClass = `msgRow${isUser ? ' msgRowUser' : isAssistant ? ' msgRowAssistant' : ''}`;
  const bubbleClass = `msgBubble${isUser ? ' msgUser' : isAssistant ? ' msgAssistant' : ' msgUnknown'}`;

  const [blobUrls, setBlobUrls] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!msg.attachments?.length) return;

    let cancelled = false;
    const urls: Record<string, string> = {};

    (async () => {
      for (const imageId of msg.attachments!) {
        if (cancelled) break;
        try {
          urls[imageId] = await client.getImageBlobUrl(imageId);
        } catch {
          // skip failed images
        }
      }
      if (!cancelled) setBlobUrls(urls);
    })();

    return () => {
      cancelled = true;
      Object.values(urls).forEach((u) => URL.revokeObjectURL(u));
    };
  }, [msg.attachments, client]);

  return (
    <div className={rowClass}>
      <div className={bubbleClass}>
        <div className="msgMeta">
          <span className="msgRole">{isUser ? '你' : isAssistant ? 'Gemini' : role}</span>
          <span className="msgTime">{formatTime(msg.timestamp)}</span>
        </div>
        <div className="msgText">{msg.content || ''}</div>

        {msg.attachments && msg.attachments.length > 0 && (
          <div className="imagesGrid">
            {msg.attachments.map((imageId) => (
              <div key={imageId} className="imageTile">
                {blobUrls[imageId] ? (
                  <img src={blobUrls[imageId]} alt={`Image ${imageId}`} />
                ) : (
                  <div className="imagePlaceholder">Loading...</div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
