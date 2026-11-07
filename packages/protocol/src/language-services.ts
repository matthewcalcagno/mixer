import { z } from "zod";

export const LanguageDocumentSelectorSchema = z
  .object({
    languageId: z.string().min(1).max(64),
    extensions: z.array(z.string().regex(/^\.[^/\\\s]+$/)).max(32),
    filenames: z.array(z.string().min(1).max(128)).max(32).optional(),
  })
  .strict();

export const LanguageServerRegistrationSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/),
    label: z.string().min(1).max(100),
    documents: z.array(LanguageDocumentSelectorSchema).min(1).max(32),
    command: z.tuple([z.string().min(1)], z.string()),
    env: z.record(z.string(), z.string()).optional(),
    initializationOptions: z.record(z.string(), z.unknown()).optional(),
    settings: z.record(z.string(), z.unknown()).optional(),
    initializationTimeoutMs: z.number().int().min(1000).max(300_000).optional(),
    watchIgnoredDirectories: z.array(z.string().min(1)).max(64).optional(),
    extensions: z
      .object({
        requests: z.array(z.string().min(1).max(160)).max(64).optional(),
        notifications: z.array(z.string().min(1).max(160)).max(64).optional(),
        commands: z.array(z.string().min(1).max(160)).max(64).optional(),
        virtualDocuments: z
          .array(
            z
              .object({
                scheme: z
                  .string()
                  .regex(/^[a-z][a-z0-9+.-]*$/)
                  .refine((value) => value !== "file"),
                method: z.string().min(1).max(160),
              })
              .strict(),
          )
          .max(16)
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const LanguageProviderSchema = z.object({
  id: z.string().min(1).max(160),
  label: z.string().min(1),
  documents: z.array(LanguageDocumentSelectorSchema),
  status: z.enum(["available", "missing"]),
  revision: z.string().optional(),
  message: z.string().optional(),
});
export type LanguageDocumentSelector = z.infer<typeof LanguageDocumentSelectorSchema>;
export type LanguageServerRegistration = z.infer<typeof LanguageServerRegistrationSchema>;
export type LanguageProvider = z.infer<typeof LanguageProviderSchema>;

export const BUILTIN_LANGUAGE_DOCUMENTS = {
  typescript: [
    { languageId: "typescript", extensions: [".ts", ".mts", ".cts"] },
    { languageId: "typescriptreact", extensions: [".tsx"] },
    { languageId: "javascript", extensions: [".js", ".mjs", ".cjs"] },
    { languageId: "javascriptreact", extensions: [".jsx"] },
  ],
  python: [{ languageId: "python", extensions: [".py", ".pyi"] }],
} satisfies Record<string, LanguageDocumentSelector[]>;

export const LEGACY_LANGUAGE_PROVIDERS: LanguageProvider[] = Object.entries(
  BUILTIN_LANGUAGE_DOCUMENTS,
).map(([id, documents]) => ({ id, label: id, documents, status: "available" }));

export function languageForDocument(
  filename: string,
  documents: readonly LanguageDocumentSelector[],
): string | null {
  const name = filename.split(/[\\/]/).pop() ?? filename;
  let language: string | null = null;
  let specificity = -1;
  for (const selector of documents) {
    if (selector.filenames?.includes(name)) return selector.languageId;
    for (const extension of selector.extensions) {
      if (name.toLowerCase().endsWith(extension.toLowerCase()) && extension.length > specificity) {
        language = selector.languageId;
        specificity = extension.length;
      }
    }
  }
  return language;
}

export function providerForDocument(
  filename: string,
  providers: readonly LanguageProvider[],
): LanguageProvider | null {
  // Plugin contributions precede built-ins so a trusted installation can replace a default.
  return (
    providers.find((provider) => languageForDocument(filename, provider.documents) !== null) ?? null
  );
}

export function providerForLanguage(
  languageId: string,
  providers: readonly LanguageProvider[],
): LanguageProvider | null {
  return (
    providers.find((provider) =>
      provider.documents.some((document) => document.languageId === languageId),
    ) ?? null
  );
}

export const WorkspaceLanguageProvidersRequestSchema = z.object({
  type: z.literal("workspace.language.providers.request"),
  requestId: z.string(),
});
export const WorkspaceLanguageProvidersResponseSchema = z.object({
  type: z.literal("workspace.language.providers.response"),
  payload: z.object({
    requestId: z.string(),
    providers: z.array(LanguageProviderSchema),
    error: z.string().optional(),
  }),
});
