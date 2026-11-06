import {
  Decoration,
  MatchDecorator,
  ViewPlugin,
  hoverTooltip,
  type EditorView,
} from "@codemirror/view";
import { autocompletion } from "@codemirror/autocomplete";
import type { CodeEditorProps } from "@mixer/plugin/client/ui";
export function variableExtensions(
  variables: NonNullable<CodeEditorProps["variables"]>,
  inspect?: (name: string) => void,
) {
  const definitions = new Map(variables.map((variable) => [variable.name, variable]));
  const matcher = new MatchDecorator({
    regexp: /\{\{\s*([^{}]+?)\s*\}\}/g,
    decoration: (match) =>
      Decoration.mark({
        class: definitions.get(match[1]!.trim())?.resolved
          ? "cm-variable-resolved"
          : "cm-variable-missing",
        attributes: { "data-mixer-variable": match[1]!.trim() },
      }),
  });
  return [
    ViewPlugin.fromClass(
      class {
        decorations;
        constructor(view: EditorView) {
          this.decorations = matcher.createDeco(view);
        }
        update(update: Parameters<MatchDecorator["updateDeco"]>[0]) {
          this.decorations = matcher.updateDeco(update, this.decorations);
        }
      },
      { decorations: (plugin) => plugin.decorations },
    ),
    autocompletion({
      override: [
        (context) => {
          const match = context.matchBefore(/\{\{[^{}]*$/);
          if (!match) return null;
          const closing = context.state.sliceDoc(context.pos, context.pos + 2) === "}}";
          return {
            from: match.from,
            to: context.pos + (closing ? 2 : 0),
            options: variables.map((variable) => ({
              label: `{{${variable.name}}}`,
              detail: variable.source,
              type: "variable",
            })),
          };
        },
      ],
    }),
    hoverTooltip((view, pos) => {
      const line = view.state.doc.lineAt(pos);
      for (const match of line.text.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) {
        const start = line.from + match.index!;
        if (pos < start || pos > start + match[0].length) continue;
        const name = match[1]!.trim();
        const definition = definitions.get(name);
        return {
          pos: start,
          end: start + match[0].length,
          above: true,
          create: () => {
            const dom = document.createElement("div");
            dom.className = "ac-code-variable-tooltip";
            const title = document.createElement("strong");
            title.textContent = `{{${name}}}`;
            dom.append(title);
            const status = document.createElement("span");
            status.textContent = definition?.resolved
              ? `Resolved · ${definition.source}`
              : "Unresolved variable";
            dom.append(status);
            if (inspect) {
              const edit = document.createElement("button");
              edit.type = "button";
              edit.textContent = definition?.resolved ? "Edit variable" : "Set variable";
              edit.addEventListener("click", () => inspect(name));
              dom.append(edit);
            }
            return { dom };
          },
        };
      }
      return null;
    }),
  ];
}
