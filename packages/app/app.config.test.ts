import { describe, expect, it } from "vitest";
import config from "./app.config";

describe("desktop renderer configuration", () => {
  it("only exports the Electron web renderer, without native targets or cloud build identity", () => {
    expect(config.expo.platforms).toEqual(["web"]);
    expect(config.expo.name).toBe("Mixer");
    expect(config.expo.web.output).toBe("single");
    expect(config.expo).not.toHaveProperty("ios");
    expect(config.expo).not.toHaveProperty("android");
    expect(config.expo.extra).not.toHaveProperty("eas");
    expect(config.expo.plugins).toEqual(["expo-router"]);
  });
});
