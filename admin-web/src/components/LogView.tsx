import React from 'react';

interface LogViewProps {
  logs: Array<{ timestamp: number; level: string; message: string }>;
}

export function LogView({ logs }: LogViewProps) {
  return (
    <div className="log-view">
      {logs.map((log, idx) => (
        <div key={idx} className={`log-entry log-${log.level.toLowerCase()}`}>
          <span className="log-time">[{new Date(log.timestamp).toISOString()}]</span>
          <span className={`log-level log-level-${log.level.toLowerCase()}`}>[{log.level}]</span>
          <span className="log-message">{log.message}</span>
        </div>
      ))}
    </div>
  );
}