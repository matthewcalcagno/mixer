import { z } from "zod";
import type { DaemonClient } from "../daemon-client.js";

const TerminalSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  cwd: z.string(),
  name: z.string(),
});

export type MixerTerminal = z.infer<typeof TerminalSchema>;

export interface MixerTerminalCreateOptions {
  workspaceId: string;
  /** Process working directory; defaults to the workspace directory. */
  cwd?: string;
  name?: string;
  command?: string;
  args?: string[];
  size?: { rows: number; cols: number };
  requestId?: string;
}

export interface MixerTerminalListOptions {
  /** Ownership filter. When supplied, cwd does not restrict the results. */
  workspaceId?: string;
  /** Workspace root directory filter for unscoped listings. */
  cwd?: string;
  requestId?: string;
}

export interface MixerTerminalListResult {
  entries: MixerTerminal[];
  requestId: string;
}

export interface MixerTerminalCaptureOptions {
  start?: number;
  end?: number;
  stripAnsi?: boolean;
  requestId?: string;
}

export type MixerTerminalCaptureResult = Awaited<ReturnType<DaemonClient["captureTerminal"]>>;

export interface MixerTerminalHandle {
  readonly id: string;
  current(): MixerTerminal | null;
  refresh(options?: { requestId?: string }): Promise<MixerTerminal | null>;
  /** Sends literal input and returns its UTF-16 length. Does not await command execution. */
  write(data: string): number;
  /** Expands CLI key tokens; other strings are literal. Returns the input's UTF-16 length. */
  sendKeys(keys: readonly string[]): number;
  capture(options?: MixerTerminalCaptureOptions): Promise<MixerTerminalCaptureResult>;
  kill(requestId?: string): Promise<void>;
}

export interface MixerTerminalActions {
  create(options: MixerTerminalCreateOptions): Promise<MixerTerminalHandle>;
  list(options?: MixerTerminalListOptions): Promise<MixerTerminalListResult>;
  ref(terminal: string | MixerTerminal): MixerTerminalHandle;
}

export interface MixerWorkspaceTerminalActions {
  create(options?: Omit<MixerTerminalCreateOptions, "workspaceId">): Promise<MixerTerminalHandle>;
  list(options?: { requestId?: string }): Promise<MixerTerminalListResult>;
}

type TerminalClient = Pick<
  DaemonClient,
  | "ensureConnected"
  | "getLastServerInfoMessage"
  | "createTerminal"
  | "listTerminals"
  | "sendTerminalInput"
  | "captureTerminal"
  | "killTerminal"
>;

/** @package */
export function createTerminalActions(
  daemonClient: TerminalClient,
  resolveWorkspaceDirectory: (workspaceId: string) => Promise<string>,
): MixerTerminalActions {
  function client(): TerminalClient {
    daemonClient.ensureConnected();
    // COMPAT(workspaceTerminals): added in v0.7.3, remove gate after 2027-09-05.
    if (daemonClient.getLastServerInfoMessage()?.features?.workspaceTerminals !== true) {
      throw new Error("Update the host to use workspace terminals through the SDK.");
    }
    return daemonClient;
  }

  const list = async (options: MixerTerminalListOptions = {}): Promise<MixerTerminalListResult> => {
    const result = await client().listTerminals(options.cwd, options.requestId, {
      workspaceId: options.workspaceId,
    });
    return {
      entries: result.terminals.map((terminal) => TerminalSchema.parse(terminal)),
      requestId: result.requestId,
    };
  };

  const ref = (terminal: string | MixerTerminal): MixerTerminalHandle => {
    const id = typeof terminal === "string" ? terminal : terminal.id;
    let current = typeof terminal === "string" ? null : terminal;
    const write = (data: string): number => {
      client().sendTerminalInput(id, { type: "input", data });
      return data.length;
    };
    return {
      id,
      current: () => current,
      refresh: async (options) => {
        const result = await list(options);
        current = result.entries.find((entry) => entry.id === id) ?? null;
        return current;
      },
      write,
      sendKeys: (keys) => write(keys.map(resolveKeyToken).join("")),
      capture: (options = {}) => {
        const { requestId, ...captureOptions } = options;
        return client().captureTerminal(id, captureOptions, requestId);
      },
      kill: async (requestId) => {
        const result = await client().killTerminal(id, requestId);
        if (!result.success) throw new Error(`Failed to kill terminal ${id}`);
        current = null;
      },
    };
  };

  return {
    create: async ({ workspaceId, cwd, name, requestId, ...options }) => {
      const driver = client();
      if (!workspaceId) throw new Error("workspaceId is required");
      const directory = cwd ?? (await resolveWorkspaceDirectory(workspaceId));
      const result = await driver.createTerminal(directory, name, requestId, {
        ...options,
        workspaceId,
      });
      if (result.error || !result.terminal) {
        throw new Error(result.error ?? "The daemon did not create a terminal");
      }
      return ref(TerminalSchema.parse(result.terminal));
    },
    list,
    ref,
  };
}

function resolveKeyToken(key: string): string {
  switch (key) {
    case "Enter":
      return "\r";
    case "Tab":
      return "\t";
    case "Escape":
      return "\u001b";
    case "Space":
      return " ";
    case "BSpace":
      return "\u007f";
    case "C-c":
      return "\u0003";
    case "C-d":
      return "\u0004";
    case "C-z":
      return "\u001a";
    case "C-l":
      return "\u000c";
    case "C-a":
      return "\u0001";
    case "C-e":
      return "\u0005";
    default:
      return key;
  }
}
