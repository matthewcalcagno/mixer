import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import path from "node:path";
import { resolveCliInstallSourcePath, resolveCliShimPath } from "./path";

describe("cli-install-path", () => {
  it("uses the bundled shim for packaged macOS installs", () => {
    expect(
      resolveCliInstallSourcePath({
        platform: "darwin",
        isPackaged: true,
        executablePath: "/Applications/Mixer.app/Contents/MacOS/Mixer",
        shimPath: "/Applications/Mixer.app/Contents/Resources/bin/mixer",
      }),
    ).toBe("/Applications/Mixer.app/Contents/Resources/bin/mixer");
  });

  it("prefers the original AppImage path on linux", () => {
    expect(
      resolveCliInstallSourcePath({
        platform: "linux",
        isPackaged: true,
        executablePath: "/tmp/.mount_mixer123/mixer",
        shimPath: "/tmp/.mount_mixer123/resources/bin/mixer",
        appImagePath: "/home/user/Applications/Mixer.AppImage",
      }),
    ).toBe("/home/user/Applications/Mixer.AppImage");
  });

  it("uses the bundled shim for packaged linux installs outside an AppImage", () => {
    expect(
      resolveCliInstallSourcePath({
        platform: "linux",
        isPackaged: true,
        executablePath: "/opt/Mixer/Mixer",
        shimPath: "/opt/Mixer/resources/bin/mixer",
      }),
    ).toBe("/opt/Mixer/resources/bin/mixer");
  });

  it("falls back to the shim on windows and in development", () => {
    expect(
      resolveCliInstallSourcePath({
        platform: "win32",
        isPackaged: true,
        executablePath: "C:\\Users\\user\\AppData\\Local\\Programs\\Mixer\\Mixer.exe",
        shimPath: "C:\\Users\\user\\AppData\\Local\\Programs\\Mixer\\resources\\bin\\mixer.cmd",
      }),
    ).toBe("C:\\Users\\user\\AppData\\Local\\Programs\\Mixer\\resources\\bin\\mixer.cmd");

    expect(
      resolveCliInstallSourcePath({
        platform: "linux",
        isPackaged: false,
        executablePath: "/opt/Mixer/mixer",
        shimPath: "/opt/Mixer/resources/bin/mixer",
      }),
    ).toBe("/opt/Mixer/resources/bin/mixer");
  });
});

describe("CLI executable selection", () => {
  const resolveWorkspaceCli = () => createRequire(import.meta.url).resolve("@mixer/cli/bin/mixer");

  it("uses the workspace CLI for an unpackaged Electron launcher", () => {
    expect(
      resolveCliShimPath({
        platform: "linux",
        isPackaged: false,
        executablePath: "/nix/store/electron/bin/electron",
        resolveWorkspaceCli,
      }),
    ).toBe(resolveWorkspaceCli());
  });

  it("uses the application shim for a packaged launcher", () => {
    expect(
      resolveCliShimPath({
        platform: "linux",
        isPackaged: true,
        executablePath: "/opt/Mixer/mixer",
        resolveWorkspaceCli,
      }),
    ).toBe(path.join("/opt/Mixer", "resources", "bin", "mixer"));
    expect(
      resolveCliShimPath({
        platform: "darwin",
        isPackaged: true,
        executablePath: "/Applications/Mixer.app/Contents/MacOS/Mixer",
        resolveWorkspaceCli,
      }),
    ).toBe(path.join("/Applications/Mixer.app", "Contents", "Resources", "bin", "mixer"));
  });
});
