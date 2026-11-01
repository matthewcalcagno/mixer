const pkg = require("./package.json");

// Electron hosts the web renderer. There are no native application targets.
export default {
  expo: {
    name: "Mixer",
    slug: "mixer",
    platforms: ["web"],
    version: pkg.version.split("-")[0],
    scheme: "mixer",
    web: {
      output: "single",
      favicon: "./assets/images/favicon.png",
    },
    plugins: ["expo-router"],
    experiments: {
      typedRoutes: true,
      reactCompiler: true,
      autolinkingModuleResolution: true,
    },
    extra: { router: {} },
  },
};
