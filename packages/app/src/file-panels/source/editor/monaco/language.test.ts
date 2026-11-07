import { describe, expect, it } from "vitest";
import { languageForFile, grammarForFile } from "./language";
import { bundledLanguagesInfo } from "shiki/langs";
import { buildLanguageModes, resolveLanguageMode } from "../language-modes";

const languages = [
  { id: "typescript", extensions: [".ts", ".tsx"] },
  { id: "javascript", extensions: [".js", ".jsx"] },
  { id: "dockerfile", filenames: ["Dockerfile"] },
  { id: "special", extensions: [".special.ts"] },
];

describe("Monaco language selection", () => {
  it.each([
    ["src/main.ts", "typescript"],
    ["C:\\repo\\App.TSX", "typescript"],
    ["src/main.special.ts", "special"],
    ["Dockerfile", "dockerfile"],
    ["src/App.vue", "vue"],
    ["infra/main.tf", "terraform"],
    ["unknown.blob", "plaintext"],
    ["changes.diff", "diff"],
    ["changes.patch", "diff"],
  ])("selects %s as %s", (filename, expected) => {
    expect(languageForFile(filename, languages)).toBe(expected);
  });

  it("keeps JSX grammars separate from the TypeScript service language", () => {
    expect(grammarForFile("App.tsx", "typescript")).toBe("tsx");
    expect(grammarForFile("App.jsx", "javascript")).toBe("jsx");
    expect(grammarForFile("main.ts", "typescript")).toBe("typescript");
    expect(grammarForFile("App.tsx", "python")).toBe("python");
  });
  it("selects plugin file aliases and new language IDs without requiring a bundled grammar", () => {
    const registrations = [
      ...languages,
      { id: "java", extensions: [".java"] },
      { id: "custom-lsp", extensions: [".custom"] },
    ];
    const modes = buildLanguageModes(registrations, bundledLanguagesInfo);
    const providers = [
      {
        id: "plugin/java",
        label: "Custom Java",
        status: "available" as const,
        documents: [{ languageId: "java", extensions: [".javasource"], filenames: ["Javasource"] }],
      },
      {
        id: "plugin/custom",
        label: "Custom LSP",
        status: "available" as const,
        documents: [{ languageId: "custom-lsp", extensions: [".custom"] }],
      },
    ];
    const resolve = (
      filename: string,
      override: string | null = null,
      associations: Record<string, string> = {},
    ) =>
      resolveLanguageMode({
        filename,
        override,
        associations,
        content: "",
        modes,
        registrations,
        providers,
      });
    expect(resolve("Main.javasource").id).toBe("java");
    expect(resolve("Javasource").id).toBe("java");
    expect(resolve("main.custom")).toMatchObject({ id: "custom-lsp", monacoId: "custom-lsp" });
    expect(resolve("Main.javasource", "plaintext").id).toBe("plaintext");
    expect(resolve("Main.javasource", null, { ".javasource": "python" }).id).toBe("python");
  });
  it("includes popular languages and resolves file modes, shebangs and explicit overrides", () => {
    const registrations = [
      ...languages,
      { id: "java", extensions: [".java"] },
      { id: "rust", extensions: [".rs"] },
    ];
    const modes = buildLanguageModes(registrations, bundledLanguagesInfo);
    expect(modes.map((mode) => mode.id)).toEqual(
      expect.arrayContaining([
        "java",
        "rust",
        "go",
        "csharp",
        "cpp",
        "python",
        "ruby",
        "php",
        "kotlin",
        "swift",
        "sql",
        "html",
        "css",
        "json",
        "shellscript",
        "plaintext",
      ]),
    );
    const resolve = (
      filename: string,
      override: string | null = null,
      content = "",
      associations: Record<string, string> = {},
    ) => resolveLanguageMode({ filename, override, content, associations, registrations, modes });
    expect(resolve("Main.java").id).toBe("java");
    expect(resolve("main.rs").id).toBe("rust");
    expect(resolve("App.tsx").id).toBe("typescriptreact");
    expect(resolve("App.tsx", "python")).toMatchObject({ id: "python", grammar: "python" });
    expect(resolve("Main.java", "plaintext").id).toBe("plaintext");
    expect(resolve("script", null, "#!/usr/bin/env python3\nprint(1)").id).toBe("python");
    expect(resolve("script", null, "#!/bin/bash\necho hi").id).toBe("shellscript");
    expect(resolve("example.demo", null, "", { ".demo": "java" }).id).toBe("java");
  });
});
