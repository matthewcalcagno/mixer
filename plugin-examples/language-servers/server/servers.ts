import type { LanguageServerRegistration } from "@mixer/plugin/server";

type Command = LanguageServerRegistration["command"];

/** Replace commands with host-installed executables, or omit languages you do not need. */
export function languageServers(
  commands: { java?: Command; rust?: Command; c?: Command } = {},
): LanguageServerRegistration[] {
  return [
    {
      id: "java",
      label: "Java (Eclipse JDT LS)",
      documents: [{ languageId: "java", extensions: [".java"] }],
      command: [
        ...(commands.java ?? ["jdtls"]),
        "--jvm-arg=-Xms128m",
        "--jvm-arg=-Xmx1g",
        "-configuration",
        "${serverData}/configuration",
        "-data",
        "${serverData}/workspace",
      ],
      initializationTimeoutMs: 180_000,
      initializationOptions: { extendedClientCapabilities: { classFileContentsSupport: true } },
      settings: { java: { autobuild: { enabled: true } } },
      extensions: { virtualDocuments: [{ scheme: "jdt", method: "java/classFileContents" }] },
    },
    {
      id: "rust",
      label: "Rust (rust-analyzer)",
      documents: [{ languageId: "rust", extensions: [".rs"] }],
      command: commands.rust ?? ["rust-analyzer"],
      initializationTimeoutMs: 60_000,
    },
    {
      id: "c",
      label: "C / C++ (clangd)",
      documents: [
        { languageId: "c", extensions: [".c", ".h"] },
        { languageId: "cpp", extensions: [".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx"] },
      ],
      command: commands.c ?? ["clangd", "--background-index"],
    },
  ];
}
