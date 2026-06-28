import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Proxy: chamadas a /api vão para o API Gateway (NestJS) em :3000 — sem CORS no dev.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:3000", changeOrigin: true },
    },
  },
});
