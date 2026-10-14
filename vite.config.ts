import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
export default defineConfig({
  plugins: [react(), tailwind()],
  server: { port: 1430, strictPort: true },
  build: { target: "es2022" },
  clearScreen: false,
});
