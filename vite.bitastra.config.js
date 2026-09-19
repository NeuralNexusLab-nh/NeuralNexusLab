import { defineConfig } from "vite";
import { resolve } from "node:path";
import wasm from "vite-plugin-wasm";
export default defineConfig({
  plugins: [wasm()],
  resolve: {
    alias: {
      "/assets/bitastra.css": resolve(__dirname, "src/bitastra.css"),
      "/assets/bitastra-landing.js": resolve(
        __dirname,
        "src/bitastra-landing.js",
      ),
      "/assets/bitastra-wallet.js": resolve(
        __dirname,
        "src/bitastra-wallet.js",
      ),
    },
  },
  build: {
    target: "esnext",
    outDir: "public",
    emptyOutDir: false,
    rollupOptions: {
      input: {
        bitastra: resolve(__dirname, "bitastra.html"),
        wallet: resolve(__dirname, "wallet.html"),
      },
    },
  },
});
