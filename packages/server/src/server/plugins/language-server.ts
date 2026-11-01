import path from "node:path";
import {
  LanguageServerRegistrationSchema,
  type LanguageServerRegistration,
} from "@mixer/protocol/language-services";

/** Resolve installation-owned paths before passing launch data to the daemon process manager. */
export function pluginLanguageServer(
  input: unknown,
  pluginId: string,
  directory: string,
): LanguageServerRegistration {
  const registration = LanguageServerRegistrationSchema.parse(input);
  const [executable, ...args] = registration.command;
  if (registration.env?.PATH?.split(path.delimiter).some((entry) => !path.isAbsolute(entry)))
    throw new Error("Language server PATH entries must be absolute directories");
  const relativeExecutable =
    !path.isAbsolute(executable) && (executable.includes("/") || executable.includes("\\"));
  return {
    ...registration,
    id: `${pluginId}/${registration.id}`,
    command: [relativeExecutable ? path.resolve(directory, executable) : executable, ...args],
  };
}
