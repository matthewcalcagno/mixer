import { z } from "zod";
import { monacoViewStateSchema } from "../persistence";
import { editorPreferencesSchema } from "../preferences";
import { LanguageProviderSchema } from "@mixer/protocol/language-services";
import { languageModeSchema } from "../language-modes";

export const monacoThemeSchema = z.object({
  colorScheme: z.enum(["light", "dark"]),
  background: z.string(),
  foreground: z.string(),
  cursor: z.string(),
  foregroundMuted: z.string(),
  border: z.string(),
  selection: z.string(),
  monoFont: z.string(),
  codeFontSize: z.number(),
});

export const editorConfigurationSchema = z.object({
  filename: z.string(),
  languageMode: z.string().max(64).nullable().optional(),
  content: z.string(),
  revision: z.number().int().nonnegative(),
  bufferVersion: z.number().int().nonnegative(),
  lineSeparator: z.enum(["\n", "\r\n", "\r"]),
  theme: monacoThemeSchema,
  vimEnabled: z.boolean(),
  preferences: editorPreferencesSchema,
  projectLanguageServices: z.boolean(),
  historyOwner: z.enum(["document", "editor"]).optional(),
  languageProviders: z.array(LanguageProviderSchema).optional(),
  extendedLanguageFeatures: z.boolean().optional(),
  gitAnnotations: z.boolean().default(false),
  viewState: monacoViewStateSchema.nullable(),
  initialLocation: z
    .object({
      lineStart: z.number().int().positive(),
      lineEnd: z.number().int().positive().optional(),
    })
    .optional(),
});

export const editorCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("focus") }),
  z.object({
    type: z.literal("git-response"),
    requestId: z.string(),
    result: z.unknown(),
    error: z.string().optional(),
  }),
  z.object({ type: z.literal("retry-language-services") }),
  z.object({
    type: z.literal("review"),
    filename: z.string(),
    before: z.string(),
    after: z.string(),
    theme: monacoThemeSchema,
    preferences: editorPreferencesSchema,
  }),
  z.object({
    type: z.literal("configure"),
    configuration: editorConfigurationSchema,
    restartLanguageServices: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("content"),
    content: z.string(),
    revision: z.number().int().nonnegative(),
    bufferVersion: z.number().int().nonnegative(),
    lineSeparator: z.enum(["\n", "\r\n", "\r"]),
  }),
  z.object({
    type: z.literal("reveal"),
    lineStart: z.number().int().positive(),
    lineEnd: z.number().int().positive().optional(),
  }),
]);

export const editorEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("language-state"),
    filename: z.string(),
    id: z.string().max(64),
    modes: z.array(languageModeSchema).max(512),
  }),
  z.object({
    type: z.literal("git-blame-request"),
    requestId: z.string(),
    content: z.string().max(1024 * 1024),
  }),
  z.object({ type: z.literal("git-commit-request"), requestId: z.string(), sha: z.string() }),
  z.object({ type: z.literal("git-copy"), text: z.string().max(256) }),
  z.object({ type: z.literal("git-open"), url: z.string() }),
  z.object({
    type: z.literal("language-connect"),
    language: z.string().min(1).max(160),
    channelId: z.string(),
    restart: z.boolean().optional(),
  }),
  z.object({ type: z.literal("language-disconnect"), channelId: z.string() }),
  z.object({ type: z.literal("language-error"), message: z.string() }),
  z.object({
    type: z.literal("open-location"),
    uri: z.string(),
    lineStart: z.number().int().positive(),
    lineEnd: z.number().int().positive(),
  }),
  z.object({ type: z.literal("booted") }),
  z.object({ type: z.literal("ready") }),
  z.object({ type: z.literal("view-state"), state: monacoViewStateSchema }),
  z.object({ type: z.literal("view-state-error"), message: z.string() }),
  z.object({ type: z.literal("save") }),
  z.object({ type: z.literal("history"), redo: z.boolean() }),
  z.object({
    type: z.literal("change"),
    content: z.string(),
    revision: z.number().int().positive(),
    baseVersion: z.number().int().nonnegative(),
  }),
  z.object({ type: z.literal("vim"), mode: z.string().nullable() }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);

export type EditorConfiguration = z.infer<typeof editorConfigurationSchema>;
export type EditorCommand = z.infer<typeof editorCommandSchema>;
export type EditorEvent = z.infer<typeof editorEventSchema>;
export type MonacoTheme = z.infer<typeof monacoThemeSchema>;
