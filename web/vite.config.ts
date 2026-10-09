import { defineConfig } from "vite";

export default defineConfig({
  // stellar-sdk and the wallet kit expect a Node-style `global`.
  define: { global: "globalThis" },
});
