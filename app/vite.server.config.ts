import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL("../", import.meta.url)),
  ssr: { noExternal: [/^@agent-fit-trace\//] },
  build: {
    ssr: "server/vercel.ts",
    outDir: "build/server",
    emptyOutDir: true,
    rollupOptions: {
      output: { entryFileNames: "vercel.mjs" },
    },
  },
});
