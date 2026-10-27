import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// Two pages: index.html = mode selector and town (three.js); studio.html = legacy Phaser scenes.
export default defineConfig({
  server: {
    host: true,
    allowedHosts: true,
  },
  build: {
    rollupOptions: {
      input: {
        town: fileURLToPath(new URL("./index.html", import.meta.url)),
        studio: fileURLToPath(new URL("./studio.html", import.meta.url)),
      },
    },
  },
});
