import { configDefaults, defineConfig, mergeConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import upstream from "./automations/server/engine/upstream/vitest.config.js";

export default mergeConfig(
  upstream,
  defineConfig({
    test: {
      maxWorkers: 1,
      // These upstream CLI fixtures wait for Unix socket files; Windows uses Mixer's named-pipe integration tests.
      exclude: [
        ...configDefaults.exclude,
        ...(process.platform === "win32"
          ? ["automations/server/engine/upstream/packages/cli/**"]
          : []),
      ],
      env: {
        MIXER_AUTOMATIONS_SDK_ROOT: fileURLToPath(
          new URL("./automations/server/engine/dist/sdk", import.meta.url),
        ),
      },
    },
    resolve: {
      alias: {
        "better-sqlite3": fileURLToPath(
          new URL("./automations/server/engine/sqlite.ts", import.meta.url),
        ),
      },
    },
  }),
);
