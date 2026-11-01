import { beforeAll, expect, test } from "vitest";
import { bundledLanguages } from "shiki/langs";
import {
  compressedSyntaxRegistry,
  monacoLanguageRegistrations,
} from "../scripts/syntax-assets.mjs";
import {
  languageForFile,
  grammarForFile,
} from "../../../packages/app/src/file-panels/source/editor/monaco/language.ts";

let offline;
let registrySize;
beforeAll(async () => {
  const source = await compressedSyntaxRegistry();
  registrySize = Buffer.byteLength(source);
  offline = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
});

test("offline diff grammars preserve the file editor's TextMate data and aliases", async () => {
  for (const id of ["tsx", "jsx", "json", "python", "rust", "markdown", "yaml", "toml"]) {
    const source = await bundledLanguages[id]();
    const expected = Array.isArray(source) ? source : source.default;
    expect(await offline.bundledLanguages[id]()).toEqual(expected);
  }
  expect(await offline.bundledLanguages.ts()).toEqual(await offline.bundledLanguages.typescript());
});

test("the offline registry deduplicates embedded grammars instead of duplicating whole bundles", () => {
  expect(registrySize).toBeLessThan(2 * 1024 * 1024);
});

test("diff filename detection uses Monaco's registrations and the normal file grammar resolver", async () => {
  const languages = await monacoLanguageRegistrations();
  const tsx = languageForFile("src/Example.tsx", languages);
  expect(tsx).toBe("typescript");
  expect(grammarForFile("src/Example.tsx", tsx)).toBe("tsx");
  expect(languageForFile("src/main.rs", languages)).toBe("rust");
  expect(languageForFile("src/main.py", languages)).toBe("python");
});
