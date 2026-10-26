import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  cacheDir: ".cache/vite",
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: { environment: "node", fsModuleCachePath: ".cache/vitest", exclude: [...configDefaults.exclude, ".cache/**"] },
});
