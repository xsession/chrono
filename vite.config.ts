import { defineConfig, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";

// In development the Vite dev server proxies API and asset calls to the
// TypeScript backend (a separate port, like the old Tauri sidecar). In
// production the backend serves `dist/` directly, so no proxy is needed.
const apiPort = process.env.CHRONO_PORT ?? "1421";
const apiTarget = `http://127.0.0.1:${apiPort}`;

const proxy: Record<string, ProxyOptions> = {
  "/api": { target: apiTarget, changeOrigin: true },
  // Public static assets (icons etc.) live next to the API server.
  "/rsrc": { target: apiTarget, changeOrigin: true },
  "/icon.svg": { target: apiTarget, changeOrigin: true },
};

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    strictPort: true,
    host: process.env.CHRONO_VITE_HOST ?? "127.0.0.1",
    port: Number.parseInt(process.env.CHRONO_VITE_PORT ?? "1420", 10),
    proxy,
  },
});
