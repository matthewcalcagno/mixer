import { z } from "zod";
import {
  EXTRA_EXTENSIONS,
  languageForFile,
  grammarForFile,
  type LanguageRegistration,
} from "./monaco/language";

export const languageModeSchema = z.object({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(100),
  monacoId: z.string().min(1).max(64),
  grammar: z.string().max(64),
  extensions: z.array(z.string()),
  filenames: z.array(z.string()),
});
export type LanguageMode = z.infer<typeof languageModeSchema>;
interface GrammarDescription {
  id: string;
  name: string;
  aliases?: string[];
}

function registrationMode(
  registration: LanguageRegistration,
  grammar: GrammarDescription | undefined,
  previous: LanguageMode | undefined,
): LanguageMode {
  return {
    id: languageServiceId(grammar?.id ?? registration.id),
    label: grammar?.name ?? registration.id,
    grammar: grammar?.id ?? registration.id,
    monacoId: previous?.monacoId ?? registration.id,
    extensions: [...new Set([...(previous?.extensions ?? []), ...(registration.extensions ?? [])])],
    filenames: [...new Set([...(previous?.filenames ?? []), ...(registration.filenames ?? [])])],
  };
}

export function languageServiceId(mode: string): string {
  if (mode === "tsx") return "typescriptreact";
  if (mode === "jsx") return "javascriptreact";
  if (mode === "docker") return "dockerfile";
  if (mode === "make") return "makefile";
  if (mode === "shell") return "shellscript";
  return mode;
}

export function buildLanguageModes(
  registrations: LanguageRegistration[],
  grammars: readonly GrammarDescription[],
): LanguageMode[] {
  const grammarNames = new Map<string, GrammarDescription>();
  for (const grammar of grammars)
    for (const alias of [grammar.id, ...(grammar.aliases ?? [])]) grammarNames.set(alias, grammar);
  const modes = new Map<string, LanguageMode>();
  for (const registration of registrations) {
    const grammar = grammarNames.get(registration.id);
    const id = languageServiceId(grammar?.id ?? registration.id);
    const previous = modes.get(id);
    modes.set(id, registrationMode(registration, grammar, previous));
  }
  for (const grammar of grammars) {
    const id = languageServiceId(grammar.id);
    if (!modes.has(id))
      modes.set(id, {
        id,
        label: grammar.name,
        grammar: grammar.id,
        monacoId: grammar.id,
        extensions: [],
        filenames: [],
      });
  }
  for (const [extension, grammarId] of Object.entries(EXTRA_EXTENSIONS))
    modes.get(languageServiceId(grammarId))?.extensions.push(`.${extension}`);
  const tsx = modes.get("typescriptreact");
  if (tsx) {
    tsx.label = "TypeScript React";
    tsx.monacoId = "typescript";
    tsx.extensions.push(".tsx");
  }
  const jsx = modes.get("javascriptreact");
  if (jsx) {
    jsx.label = "JavaScript React";
    jsx.monacoId = "javascript";
    jsx.extensions.push(".jsx");
  }
  modes.set("plaintext", {
    id: "plaintext",
    label: "Plain Text",
    monacoId: "plaintext",
    grammar: "",
    extensions: [".txt"],
    filenames: [],
  });
  return [...modes.values()].sort((a, b) => a.label.localeCompare(b.label));
}

export function fileAssociationKey(filename: string): string {
  const name = filename.split(/[\\/]/).pop() ?? filename;
  const index = name.lastIndexOf(".");
  return index > 0 ? name.slice(index).toLowerCase() : name;
}

function shebangLanguage(content: string): string | null {
  const first = content.split("\n", 1)[0].slice(0, 512);
  if (!first.startsWith("#!")) return null;
  if (/\bpython[\d.]*\b/.test(first)) return "python";
  if (/\b(node|nodejs|deno|bun)\b/.test(first)) return "javascript";
  if (/\b(bash|zsh|sh)\b/.test(first)) return "shellscript";
  if (/\bruby\b/.test(first)) return "ruby";
  if (/\bperl\b/.test(first)) return "perl";
  if (/\bphp\b/.test(first)) return "php";
  return null;
}

export function resolveLanguageMode(input: {
  filename: string;
  content: string;
  override: string | null;
  associations: Record<string, string>;
  modes: LanguageMode[];
  registrations: LanguageRegistration[];
}): LanguageMode {
  const { filename, modes } = input;
  const explicit = modes.find((mode) => mode.id === input.override);
  if (explicit) return explicit;
  const name = filename.split(/[\\/]/).pop() ?? filename;
  const suffix = Object.keys(input.associations)
    .filter((key) => key.startsWith(".") && name.toLowerCase().endsWith(key.toLowerCase()))
    .sort((a, b) => b.length - a.length)[0];
  const associated = modes.find(
    (mode) => mode.id === (input.associations[name] ?? input.associations[suffix ?? ""]),
  );
  if (associated) return associated;
  const detected = languageForFile(filename, input.registrations);
  const grammar = grammarForFile(filename, detected);
  const id = detected === "plaintext" ? shebangLanguage(input.content) : languageServiceId(grammar);
  return (
    modes.find((mode) => mode.id === id) ??
    modes.find((mode) => mode.grammar === grammar) ??
    modes.find((mode) => mode.monacoId === detected) ??
    modes.find((mode) => mode.id === "plaintext") ?? {
      id: "plaintext",
      label: "Plain Text",
      monacoId: "plaintext",
      grammar: "",
      extensions: [],
      filenames: [],
    }
  );
}
