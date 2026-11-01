import type { ThemeRegistration } from "shiki";

// Syntax scopes adapted from DubeSoftware's GitHub Dark Turbo 0.6.1 (MIT).
// https://github.com/dubesoftware/github-dark-turbo
// See editor-syntax.LICENSE.txt. No editor UI or token background colors are imported.
const dark = {
  comment: "#6A737D",
  blue: "#79B8FF",
  purple: "#B392F0",
  foreground: "#E1E4E8",
  green: "#85E89D",
  red: "#F97583",
  string: "#9ECBFF",
  orange: "#FFAB70",
  invalid: "#FDAEB7",
  regexp: "#DBEDFF",
  muted: "#2F363D",
  bracket: "#D1D5DA",
  info: "#6796E6",
  warning: "#CD9731",
  error: "#F44747",
  debug: "#B267E6",
};

// Preserve the dark palette's hue roles with darker shades for light editor surfaces.
const light: typeof dark = {
  comment: "#586069",
  blue: "#005CC5",
  purple: "#6F42C1",
  foreground: "#24292E",
  green: "#22863A",
  red: "#D73A49",
  string: "#032F62",
  orange: "#A04100",
  invalid: "#B31D28",
  regexp: "#032F62",
  muted: "#586069",
  bracket: "#444D56",
  info: "#005CC5",
  warning: "#735C0F",
  error: "#B31D28",
  debug: "#6F42C1",
};

function createEditorSyntaxTheme(type: "dark" | "light", palette: typeof dark): ThemeRegistration {
  const rule = (scope: string | string[], foreground: string, fontStyle?: string) => ({
    scope,
    settings: { foreground, ...(fontStyle ? { fontStyle } : {}) },
  });
  return {
    name: `github-turbo-${type}`,
    displayName: type === "dark" ? "GitHub Dark Turbo" : "GitHub Turbo Light",
    type,
    // Monaco's UI theme remains the sole owner of the editor background.
    colors: { "editor.foreground": palette.foreground },
    tokenColors: [
      rule(["comment", "punctuation.definition.comment", "string.comment"], palette.comment),
      rule(
        ["constant", "entity.name.constant", "variable.other.constant", "variable.language"],
        palette.blue,
      ),
      rule(["entity", "entity.name"], palette.purple),
      rule("variable.parameter.function", palette.foreground),
      rule("entity.name.tag", palette.green),
      rule(["keyword", "storage", "storage.type"], palette.red),
      rule(
        ["storage.modifier.package", "storage.modifier.import", "storage.type.java"],
        palette.foreground,
      ),
      rule(
        ["string", "punctuation.definition.string", "string punctuation.section.embedded source"],
        palette.string,
      ),
      rule(["support", "meta.property-name"], palette.blue),
      rule("variable", palette.orange),
      rule("variable.other", palette.foreground),
      rule(
        ["invalid.broken", "invalid.deprecated", "invalid.illegal", "invalid.unimplemented"],
        palette.invalid,
        "italic",
      ),
      rule("carriage-return", palette.red, "italic underline"),
      rule("message.error", palette.invalid),
      rule("string source", palette.foreground),
      rule("string variable", palette.blue),
      rule(
        [
          "source.regexp",
          "string.regexp",
          "string.regexp.character-class",
          "string.regexp constant.character.escape",
          "string.regexp source.ruby.embedded",
          "string.regexp string.regexp.arbitrary-repitition",
        ],
        palette.regexp,
      ),
      rule("string.regexp constant.character.escape", palette.green, "bold"),
      rule(["support.constant", "support.variable", "meta.module-reference"], palette.blue),
      rule("punctuation.definition.list.begin.markdown", palette.orange),
      rule(["markup.heading", "markup.heading entity.name"], palette.blue, "bold"),
      rule("markup.quote", palette.green),
      rule("markup.italic", palette.foreground, "italic"),
      rule("markup.bold", palette.foreground, "bold"),
      rule("markup.raw", palette.blue),
      rule(
        ["markup.deleted", "meta.diff.header.from-file", "punctuation.definition.deleted"],
        palette.invalid,
      ),
      rule(
        ["markup.inserted", "meta.diff.header.to-file", "punctuation.definition.inserted"],
        palette.green,
      ),
      rule(["markup.changed", "punctuation.definition.changed"], palette.orange),
      rule(["markup.ignored", "markup.untracked"], palette.muted),
      rule("meta.diff.range", palette.purple, "bold"),
      rule("meta.diff.header", palette.blue),
      rule("meta.separator", palette.blue, "bold"),
      rule("meta.output", palette.blue),
      rule(
        [
          "brackethighlighter.tag",
          "brackethighlighter.curly",
          "brackethighlighter.round",
          "brackethighlighter.square",
          "brackethighlighter.angle",
          "brackethighlighter.quote",
        ],
        palette.bracket,
      ),
      rule("brackethighlighter.unmatched", palette.invalid),
      rule(["constant.other.reference.link", "string.other.link"], palette.regexp, "underline"),
      rule("token.info-token", palette.info),
      rule("token.warn-token", palette.warning),
      rule("token.error-token", palette.error),
      rule("token.debug-token", palette.debug),
    ],
  };
}

export const editorSyntaxThemes = {
  dark: createEditorSyntaxTheme("dark", dark),
  light: createEditorSyntaxTheme("light", light),
};
