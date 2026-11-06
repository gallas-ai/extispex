import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // During development the UI talks to a locally running gateway.
    proxy: { "/v1": "http://127.0.0.1:8080" },
  },
});
