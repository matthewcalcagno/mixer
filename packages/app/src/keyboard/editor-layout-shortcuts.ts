import { z } from "zod";
import type { KeyboardActionId } from "./actions";

export const EDITOR_LAYOUT_ACTIONS = new Set<KeyboardActionId>([
  "sidebar.toggle.left",
  "sidebar.toggle.right",
  "workspace.tab.menu.open",
  "workspace.new",
  "workspace.pane.split.right",
  "workspace.pane.split.down",
]);

export const EditorShortcutPolicySchema = z.object({
  isMac: z.boolean(),
  isDesktop: z.boolean(),
  overrides: z.record(z.string(), z.string()),
});
export type EditorShortcutPolicy = z.infer<typeof EditorShortcutPolicySchema>;

export const EditorShortcutPolicyMessageSchema = z.object({
  source: z.literal("mixer-editor-shortcuts"),
  type: z.literal("policy"),
  policy: EditorShortcutPolicySchema,
});

export const EditorShortcutInputMessageSchema = z.object({
  source: z.literal("mixer-editor-shortcuts"),
  type: z.literal("input"),
  input: z.object({
    key: z.string().max(64),
    code: z.string().max(64),
    altKey: z.boolean(),
    ctrlKey: z.boolean(),
    metaKey: z.boolean(),
    shiftKey: z.boolean(),
    repeat: z.boolean(),
  }),
});
export type EditorShortcutInput = z.infer<typeof EditorShortcutInputMessageSchema>["input"];
