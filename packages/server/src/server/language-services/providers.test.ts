import { describe, expect, it } from "vitest";
import path from "node:path";
import { languageForDocument, providerForDocument } from "@mixer/protocol/language-services";
import { LanguageServerRegistry } from "./providers.js";
import { pluginLanguageServer } from "../plugins/language-server.js";

describe("language server registry", () => {
  it("keeps bundled languages and discovers additional tools without starting processes", async () => {
    const registry = new LanguageServerRegistry();
    const catalog = await registry.catalog();
    expect(catalog.map((provider) => provider.id)).toEqual([
      "typescript",
      "python",
      "gopls",
      "rust-analyzer",
      "clangd",
    ]);
    expect(catalog[0].status).toBe("available");
    expect(providerForDocument("src/main.rs", catalog)?.id).toBe("rust-analyzer");
    expect(providerForDocument("src/main.go", catalog)?.id).toBe("gopls");
    expect(providerForDocument("src/main.cpp", catalog)?.id).toBe("clangd");
    expect(providerForDocument("unknown.blob", catalog)).toBeNull();
  });
  it("supports plugin-owned custom servers and resolves executables relative to the installation", async () => {
    const directory = path.resolve("plugins", "languages");
    const definition = pluginLanguageServer(
      {
        id: "custom",
        label: "Custom",
        command: ["./bin/server", "--stdio"],
        documents: [{ languageId: "custom", extensions: [".custom"] }],
      },
      "languages",
      directory,
    );
    const registry = new LanguageServerRegistry(() => [definition]);
    expect(registry.get("languages/custom").command).toEqual([
      path.join(directory, "bin/server"),
      "--stdio",
    ]);
    const catalog = await registry.catalog();
    expect(providerForDocument("hello.custom", catalog)).toMatchObject({
      id: "languages/custom",
      status: "missing",
    });
    expect(() => registry.get("not-installed")).toThrow("not registered");
    expect(() =>
      pluginLanguageServer(
        {
          id: "unsafe",
          label: "Unsafe",
          documents: [{ languageId: "test", extensions: [".test"] }],
          command: ["server"],
          env: { PATH: "./bin" },
        },
        "languages",
        directory,
      ),
    ).toThrow("absolute directories");
  });
  it("selects language IDs with filename and longest-extension matching", () => {
    const selectors = [
      { languageId: "javascript", extensions: [".js"] },
      { languageId: "special", extensions: [".special.js"], filenames: ["Specialfile"] },
    ];
    expect(languageForDocument("C:\\repo\\App.special.js", selectors)).toBe("special");
    expect(languageForDocument("/repo/Specialfile", selectors)).toBe("special");
    expect(languageForDocument("/repo/App.js", selectors)).toBe("javascript");
    expect(languageForDocument("/repo/Other", selectors)).toBeNull();
  });
});
