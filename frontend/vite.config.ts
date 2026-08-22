import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "fs";

// Single source of truth for the app version: electron/package.json (bumped
// by the release flow). The frontend's own package.json is a dev manifest
// that never changes, so it must not drive what users see in Settings.
const electronPkg = JSON.parse(readFileSync(new URL("../electron/package.json", import.meta.url), "utf-8"));

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(electronPkg.version),
  },
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:3000',
        ws: true,
      },
    },
  },
});
