import { describe, expect, it } from "vitest";
import { getFileIconSvg, getFolderIconSvg } from "./file-icon-svg";
import { getRawFileIconSvg, getRawFolderIconSvg } from "./material-file-icons";
import data from "./material-file-icons.generated.json";

function hexColors(svg: string): string[] {
  return svg.match(/#[0-9a-fA-F]{6}/g) ?? [];
}

/** How far a colour is from grey, measured crudely enough not to re-derive the implementation. */
function channelSpread(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16));
  return Math.max(r, g, b) - Math.min(r, g, b);
}

describe("getFileIconSvg", () => {
  it.each(["Main.pas", "Main.qs", "config.merlin", ".puppeteerrc"])(
    "does not forward decorative SVG accessibility metadata from %s to SvgXml",
    (filename) => {
      expect(getRawFileIconSvg(filename)).toContain("aria-label=");
      expect(getFileIconSvg(filename)).not.toMatch(/\saria-/);
      expect(getFileIconSvg(filename)).toContain("<path");
    },
  );
  it.each(["tsconfig.json", "jsconfig.json", "typedoc.json", ".rubocop.yml"])(
    "removes non-rendering theme metadata from %s",
    (filename) => {
      expect(getRawFileIconSvg(filename)).toContain('data-mit-no-recolor="true"');
      expect(getFileIconSvg(filename)).not.toMatch(/\sdata-/);
      expect(getFileIconSvg(filename)).toContain("<svg");
    },
  );
  it("preserves TypeDoc geometry when preparing it for React Native SVG", () => {
    expect(getFileIconSvg("typedoc.json")).toContain('d="m8 1 6 3.5L8 8 2 4.5z"');
    expect(hexColors(getFileIconSvg("typedoc.json"))).toHaveLength(4);
  });
  it.each([false, true])("removes folder metadata for expanded=%s", (expanded) => {
    expect(getRawFolderIconSvg({ folderName: "gitlab", expanded })).toContain(
      "data-mit-no-recolor",
    );
    expect(getFolderIconSvg({ folderName: "gitlab", expanded })).not.toMatch(/\sdata-/);
  });
  it("keeps the vendor geometry and only rewrites colours", () => {
    const raw = getRawFileIconSvg("index.ts");
    const toned = getFileIconSvg("index.ts");
    expect(toned).not.toBe(raw);
    expect(toned.replace(/#[0-9a-fA-F]{6}/g, "#")).toBe(raw.replace(/#[0-9a-fA-F]{6}/g, "#"));
  });

  it("pulls every colour toward neutral", () => {
    const spread = (svg: string) => hexColors(svg).map(channelSpread);

    for (const file of ["main.ts", "app.jsx", "style.css", "data.json", "notes.md"]) {
      const before = spread(getRawFileIconSvg(file));
      const after = spread(getFileIconSvg(file));
      expect(after).toHaveLength(before.length);
      after.forEach((value, index) => expect(value).toBeLessThan(before[index]));
    }
  });

  it("leaves non-colour attributes alone", () => {
    const toned = getFileIconSvg("Main.kt");
    expect(toned).toContain('fill="url(#a)"');
  });

  it("returns the same string for repeated lookups", () => {
    expect(getFileIconSvg("a.ts")).toBe(getFileIconSvg("b.ts"));
  });

  it("falls back to the default icon for unknown extensions", () => {
    expect(getFileIconSvg("thing.qqq")).toBe(getFileIconSvg("thing"));
  });
});

describe("Material Icon Theme associations", () => {
  it.each([
    [".gitignore", "git"],
    [".gitattributes", "git"],
    ["package.json", "nodejs"],
    ["PACKAGE.JSON", "nodejs"],
    ["src/example.test.ts", "test-ts"],
    ["C:\\project\\example.test.ts", "test-ts"],
    ["README.md", "readme"],
    ["src/main.js", "javascript"],
    ["src/main.ts", "typescript"],
    ["config.yml", "yaml"],
    ["config.yaml", "yaml"],
    ["src/MAIN.TS", "typescript"],
    ["src/main.mjs", "javascript"],
    ["src/main.cts", "typescript"],
    ["src/main.py", "python"],
    ["src/main.rs", "rust"],
    ["src/main.go", "go"],
    ["src/Main.java", "java"],
    ["src/Main.cs", "csharp"],
    ["src/main.cpp", "cpp"],
    ["src/main.c", "c"],
    ["src/main.rb", "ruby"],
    ["src/main.swift", "swift"],
    ["src/main.php", "php"],
    ["src/style.css", "css"],
    ["src/style.scss", "sass"],
    ["src/query.sql", "database"],
    ["scripts/start.sh", "console"],
    ["scripts/start.ps1", "powershell"],
  ])("resolves %s to %s", (file, icon) => {
    const icons: Record<string, string> = data.icons;
    expect(getRawFileIconSvg(file)).toBe(icons[icon]);
  });

  it("includes every manifest association's SVG", () => {
    const icons: Record<string, string> = data.icons;
    const tables: Record<string, string>[] = [
      data.fileNames,
      data.fileExtensions,
      data.languageIds,
      data.languageFileExtensions,
      data.languageFileNames,
      data.folderNames,
      data.folderNamesExpanded,
      data.rootFolderNames,
      data.rootFolderNamesExpanded,
      ...Object.values(data.light),
    ];
    for (const associations of tables) {
      for (const icon of Object.values(associations)) {
        expect(icons[icon], icon).toContain("<svg");
      }
    }
  });

  it("resolves named folders and their expanded variants", () => {
    expect(getRawFolderIconSvg({ folderName: ".github", expanded: false })).toBe(
      data.icons["folder-github"],
    );
    expect(getRawFolderIconSvg({ folderName: ".github", expanded: true })).toBe(
      data.icons["folder-github-open"],
    );
  });

  it("uses folder fallbacks for unrecognized directories", () => {
    expect(getRawFolderIconSvg({ folderName: "unknown-folder", expanded: false })).toBe(
      data.icons.folder,
    );
    expect(getRawFolderIconSvg({ folderName: "unknown-folder", expanded: true })).toBe(
      data.icons["folder-open"],
    );
  });
});
