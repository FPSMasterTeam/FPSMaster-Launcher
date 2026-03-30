import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
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
