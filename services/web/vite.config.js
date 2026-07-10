import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// Proxy: chamadas a /api vão para o API Gateway (NestJS) — sem CORS no dev.
// O alvo é configurável via VITE_API_PROXY (ex.: em .env.local, gitignored)
// para quando a porta padrão 3000 estiver ocupada por outro processo.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const target = env.VITE_API_PROXY || "http://localhost:3000";
  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        "/api": { target, changeOrigin: true },
      },
    },
  };
});
