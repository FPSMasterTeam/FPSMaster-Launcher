import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url))
    }
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          // Keep the React runtime in its own chunk so it stays cached across
          // app updates (only the app chunk changes between releases).
          if (/node_modules\/\.pnpm\/(react|react-dom|scheduler)@/.test(id)) {
            return "react-vendor";
          }
          return undefined;
        }
      }
    }
  },
  server: {
    port: 1420,
    strictPort: true,
    proxy: {
      "/api": {
        target: "https://api.fpsmaster.top",
        changeOrigin: true,
        secure: true
      }
    }
  }
});
