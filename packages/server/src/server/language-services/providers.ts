// oxlint-disable-next-line typescript-eslint/triple-slash-reference -- The resolver's ambient dependency must also follow cross-workspace source imports.
/// <reference path="../../executable-resolution/which.d.ts" />
import path from "node:path";
import { createHash } from "node:crypto";
import {
  BUILTIN_LANGUAGE_DOCUMENTS,
  type LanguageServerRegistration,
  type LanguageProvider,
} from "@mixer/protocol/language-services";
import { findExecutableWithoutProbing } from "../../executable-resolution/executable-resolution.js";
import { languageServerPackageRoot } from "./runtime.js";

export function builtinLanguageServers(): LanguageServerRegistration[] {
  return [
    {
      id: "typescript",
      label: "TypeScript / JavaScript",
      documents: BUILTIN_LANGUAGE_DOCUMENTS.typescript,
      command: [
        process.execPath,
        "--max-old-space-size=512",
        path.join(languageServerPackageRoot("typescript-language-server"), "lib/cli.mjs"),
        "--stdio",
      ],
      env: { ELECTRON_RUN_AS_NODE: "1" },
      initializationOptions: {
        disableAutomaticTypingAcquisition: true,
        maxTsServerMemory: 3072,
        tsserver: {
          path: path.join(languageServerPackageRoot("typescript"), "lib/tsserver.js"),
          useSyntaxServer: "never",
          logVerbosity: "off",
        },
        preferences: {
          includeCompletionsForModuleExports: true,
          includeCompletionsWithInsertText: true,
          includeCompletionsWithSnippetText: true,
          providePrefixAndSuffixTextForRename: true,
        },
      },
    },
    {
      id: "python",
      label: "Python",
      documents: BUILTIN_LANGUAGE_DOCUMENTS.python,
      command: [
        process.execPath,
        "--max-old-space-size=512",
        path.join(languageServerPackageRoot("pyright"), "langserver.index.js"),
        "--stdio",
      ],
      env: { ELECTRON_RUN_AS_NODE: "1" },
      settings: {
        python: {
          analysis: {
            diagnosticMode: "openFilesOnly",
            autoSearchPaths: true,
            useLibraryCodeForTypes: true,
          },
        },
      },
    },
    {
      id: "gopls",
      label: "Go (gopls)",
      documents: [{ languageId: "go", extensions: [".go"] }],
      command: ["gopls"],
    },
    {
      id: "rust-analyzer",
      label: "Rust (rust-analyzer)",
      documents: [{ languageId: "rust", extensions: [".rs"] }],
      command: ["rust-analyzer"],
    },
    {
      id: "clangd",
      label: "C / C++ (clangd)",
      documents: [
        { languageId: "c", extensions: [".c", ".h"] },
        { languageId: "cpp", extensions: [".cc", ".cpp", ".cxx", ".hpp", ".hxx", ".hh"] },
      ],
      command: ["clangd", "--background-index"],
    },
  ];
}

export class LanguageServerRegistry {
  private catalogRequest: { key: string; task: Promise<LanguageProvider[]> } | null = null;
  constructor(
    private readonly contributions: () => readonly LanguageServerRegistration[] = () => [],
  ) {}

  registrations(): LanguageServerRegistration[] {
    const registrations = [...this.contributions(), ...builtinLanguageServers()];
    const ids = new Set<string>();
    for (const registration of registrations) {
      if (ids.has(registration.id))
        throw new Error(`Duplicate language server: ${registration.id}`);
      ids.add(registration.id);
    }
    return registrations;
  }

  get(id: string): LanguageServerRegistration {
    const registration = this.registrations().find((provider) => provider.id === id);
    if (!registration) throw new Error(`Language server is not registered: ${id}`);
    return registration;
  }

  catalog(): Promise<LanguageProvider[]> {
    const registrations = this.registrations();
    const key = JSON.stringify(registrations);
    if (this.catalogRequest?.key === key) return this.catalogRequest.task;
    const pending = this.readCatalog(registrations);
    this.catalogRequest = { key, task: pending };
    void pending
      .finally(() => {
        if (this.catalogRequest?.task === pending) this.catalogRequest = null;
      })
      .catch(() => undefined);
    return pending;
  }

  private async readCatalog(
    registrations: LanguageServerRegistration[],
  ): Promise<LanguageProvider[]> {
    return Promise.all(
      registrations.map(async (definition) => {
        const { id, label, documents, command, env } = definition;
        const available = !!(await findExecutableWithoutProbing(command[0], {
          cwd: process.cwd(),
          path: env?.PATH,
        }));
        const revision = createHash("sha256").update(JSON.stringify(definition)).digest("hex");
        return {
          id,
          label,
          documents,
          revision,
          status: available ? "available" : "missing",
          message: available
            ? undefined
            : `Install ${command[0]} on the workspace host, or configure a language-provider plugin with its executable path.`,
        };
      }),
    );
  }
}
