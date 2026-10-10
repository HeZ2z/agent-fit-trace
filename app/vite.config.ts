import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Share the dev API port with `server/devApiServer.ts`: it honors
// `FIT_TRACE_DEV_API_PORT` (default 5199), so the proxy must read the same
// setting or a custom API port would leave Vite forwarding at the old one.
const devApiPort = Number(process.env.FIT_TRACE_DEV_API_PORT ?? 5199);

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": { target: `http://127.0.0.1:${devApiPort}`, changeOrigin: true },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
  },
});
