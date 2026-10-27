import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

export default defineConfig({
  plugins: [solid()],
  root: "src",
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { target: "esnext", outDir: "../dist", sourcemap: false },
});
