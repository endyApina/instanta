import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  build: { outDir: "../dist/web", emptyOutDir: true },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": { target: `http://127.0.0.1:${process.env.PORT ?? "3000"}`, ws: true },
      "/demo-api": { target: `http://127.0.0.1:${process.env.PORT ?? "3000"}`, ws: true },
    },
  },
});
