import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

export default defineConfig({
  plugins: [react()],
  server: {
    headers: {
      // Required for sql.js WASM to load correctly in dev
      "Cross-Origin-Opener-Policy":   "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  optimizeDeps: {
    exclude: ["sql.js"],   // prevent Vite from trying to pre-bundle WASM
  },
})
