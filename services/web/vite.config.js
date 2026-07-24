import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// Proxy: chamadas a /api vão para o API Gateway (NestJS) — sem CORS no dev.
// O alvo é configurável via VITE_API_PROXY (ex.: em .env.local, gitignored)
// para quando a porta padrão 3000 estiver ocupada por outro processo.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const target = env.VITE_API_PROXY || "http://localhost:3000";
  // Host extra permitido (ex.: domínio ngrok) para servir o painel via HTTPS —
  // necessário no teste do popup do Embedded Signup. Configurável e gitignored.
  const allowedHost = env.VITE_ALLOWED_HOST;
  return {
    plugins: [react()],
    server: {
      port: 5173,
      allowedHosts: allowedHost ? [allowedHost] : undefined,
      proxy: {
        "/api": { target, changeOrigin: true },
      },
    },
    // Produção (vite preview atrás do Railway): libera os domínios públicos do
    // painel — sem isso o Vite bloqueia requests com Host desconhecido.
    preview: {
      allowedHosts: [
        "zaplane.com.br",
        "www.zaplane.com.br",
        ...(allowedHost ? [allowedHost] : []),
      ],
    },
  };
});
