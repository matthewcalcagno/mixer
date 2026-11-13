import type * as Monaco from "monaco-editor";
import { createHighlighterCore } from "shiki/core";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";
import { editorSyntaxThemes } from "../../../../styles/editor-syntax";

export function createTextMateHighlighter() {
  return createHighlighterCore({
    // Shiki normalizes registrations in place; keep the shared definitions unchanged.
    themes: Object.values(editorSyntaxThemes).map((theme) => structuredClone(theme)),
    langs: [],
    engine: createOnigurumaEngine(import("shiki/wasm")),
  });
}

type TextMateHighlighter = Awaited<ReturnType<typeof createTextMateHighlighter>>;
type TextMateGrammar = ReturnType<TextMateHighlighter["getLanguage"]>;
type TextMateStack = Parameters<TextMateGrammar["tokenizeLine2"]>[1];

class TextMateState implements Monaco.languages.IState {
  constructor(readonly stack: TextMateStack = null) {}
  clone() {
    return new TextMateState(this.stack);
  }
  equals(other: Monaco.languages.IState) {
    return other instanceof TextMateState && this.stack === other.stack;
  }
}

interface TextMateRegistration {
  monaco: typeof Monaco;
  highlighter: TextMateHighlighter;
  language: string;
  grammarLanguage: string;
}

export function registerTextMateLanguage({
  monaco,
  highlighter,
  language,
  grammarLanguage,
}: TextMateRegistration) {
  const grammar = highlighter.getLanguage(grammarLanguage);
  return monaco.languages.setTokensProvider(language, {
    getInitialState: () => new TextMateState(),
    tokenizeEncoded(line, state) {
      if (!(state instanceof TextMateState)) throw new Error("Invalid TextMate tokenizer state");
      const result = grammar.tokenizeLine2(line, state.stack, 50);
      const languageId = monaco.languages.getEncodedLanguageId(language);
      for (let index = 1; index < result.tokens.length; index += 2)
        result.tokens[index] = (result.tokens[index] & ~255) | languageId;
      return { tokens: result.tokens, endState: new TextMateState(result.ruleStack) };
    },
  });
}
