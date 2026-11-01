export interface LanguageRegistration {
  id: string;
  filenames?: string[];
  extensions?: string[];
}

export const EXTRA_EXTENSIONS: Record<string, string> = {
  diff: "diff",
  patch: "diff",
  pyi: "python",
  astro: "astro",
  vue: "vue",
  svelte: "svelte",
  mdx: "mdx",
  nix: "nix",
  tf: "terraform",
  tfvars: "terraform",
  hcl: "hcl",
  toml: "toml",
  prisma: "prisma",
  gleam: "gleam",
  typ: "typst",
};

export function languageForFile(filename: string, languages: LanguageRegistration[]): string {
  const name = filename.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";
  for (const language of languages) {
    if (language.filenames?.some((candidate) => candidate.toLowerCase() === name))
      return language.id;
  }
  const extension = name.split(".").pop() ?? "";
  if (Object.hasOwn(EXTRA_EXTENSIONS, extension)) return EXTRA_EXTENSIONS[extension];
  let best = "plaintext";
  let length = 0;
  for (const language of languages) {
    for (const suffix of language.extensions ?? []) {
      if (suffix.length > length && name.endsWith(suffix.toLowerCase())) {
        best = language.id;
        length = suffix.length;
      }
    }
  }
  return best;
}

export function grammarForFile(filename: string, language: string): string {
  const lower = filename.toLowerCase();
  if (language === "typescript" && lower.endsWith(".tsx")) return "tsx";
  if (language === "javascript" && lower.endsWith(".jsx")) return "jsx";
  return language;
}
