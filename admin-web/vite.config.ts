import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';

// Custom plugin to update project status
const updateStatusPlugin = () => {
  return {
    name: 'update-status-plugin',
    configureServer(server) {
      server.httpServer?.once('listening', () => {
        const statusPath = path.resolve(__dirname, '../STATUS.json');
        const statusContent = { status: "RUNNING", timestamp: new Date().toISOString() };
        
        try {
          fs.writeFileSync(statusPath, JSON.stringify(statusContent, null, 2));
          console.log(`[update-status-plugin] Project status updated to RUNNING at ${statusPath}`);
        } catch (error) {
          console.error(`[update-status-plugin] Failed to update status:`, error);
        }
      });
    },
    // Optional: Also update on build start if needed, but primary goal is dev server
    buildStart() {
       // This hook runs on both serve and build, but for persistent server status, configureServer's listening event is more accurate for "when it's actually up"
    }
  };
};

export default defineConfig({
  plugins: [react(), updateStatusPlugin()],
  server: {
    host: 'localhost',
    port: 5173,
    strictPort: true
  }
});