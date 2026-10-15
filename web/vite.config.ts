import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const api = `http://127.0.0.1:${process.env.AGENT_DASHBOARD_PORT ?? 5190}`;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // A local tool: one bundle is fine.
  build: { chunkSizeWarningLimit: 1500 },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: { "/api": { target: api, changeOrigin: true } },
  },
});
