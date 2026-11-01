import type pino from "pino";
import { ResponseError } from "vscode-jsonrpc/node.js";
import type { SessionOutboundMessage, WorkspaceLanguageRequest } from "@mixer/protocol/messages";
import type { SessionDelivery } from "../session/owned-subscriptions/index.js";
import { WorkspaceLanguageSession } from "./session.js";
import { LanguageServerRegistry } from "./providers.js";

interface LanguageTransportOptions {
  registry?: LanguageServerRegistry;
  getWorkspaceRoot(workspaceId: string): Promise<string | null>;
  emit(message: SessionOutboundMessage, source?: object): void;
  logger: pino.Logger;
}

interface SourceSession {
  manager: WorkspaceLanguageSession;
  notifications: Map<string, LanguageChannel>;
}
interface LanguageChannel {
  owner: ReturnType<SessionDelivery["operation"]>;
  workspaceId: string;
  language: WorkspaceLanguageRequest["language"];
}

export class WorkspaceLanguageTransport {
  private readonly sources = new Map<object, SourceSession>();
  constructor(private readonly options: LanguageTransportOptions) {}

  async handle(
    request: WorkspaceLanguageRequest,
    delivery: SessionDelivery,
    source?: object,
  ): Promise<void> {
    const sourceKey = source ?? this;
    let registration: ReturnType<SessionDelivery["operation"]> | undefined;
    try {
      if (request.method === "shutdown" || request.method === "exit") {
        await this.sources.get(sourceKey)?.notifications.get(request.channelId)?.owner.release();
        this.options.emit(
          {
            type: "workspace.language.query.response",
            payload: { requestId: request.requestId, result: null },
          },
          source,
        );
        return;
      }
      let session = this.sources.get(sourceKey);
      if (!session) {
        if (request.method !== "initialize")
          throw new Error("Initialize the language service first");
        const notifications = new Map<string, LanguageChannel>();
        const manager = new WorkspaceLanguageSession({
          registry: this.options.registry,
          getWorkspaceRoot: this.options.getWorkspaceRoot,
          logger: this.options.logger,
          emit: (message) => {
            for (const channel of notifications.values()) {
              if (
                channel.workspaceId === message.payload.workspaceId &&
                channel.language === message.payload.language
              ) {
                channel.owner.emit(message);
                break;
              }
            }
          },
        });
        session = { manager, notifications };
        this.sources.set(sourceKey, session);
      }
      const current = session;
      const channel = current.notifications.get(request.channelId);
      if (
        channel &&
        (channel.workspaceId !== request.workspaceId || channel.language !== request.language)
      ) {
        throw new Error("Language service editor channel belongs to another workspace or language");
      }
      if (request.method === "initialize" && !current.notifications.has(request.channelId)) {
        const owner = delivery.operation(
          (message) =>
            message.type === "workspace.language.notification" &&
            message.payload.workspaceId === request.workspaceId &&
            message.payload.language === request.language,
          async () => {
            current.notifications.delete(request.channelId);
            try {
              await current.manager.releaseChannel(request);
            } finally {
              if (current.notifications.size === 0) {
                this.sources.delete(sourceKey);
                await current.manager.dispose();
              }
            }
          },
        );
        registration = owner;
        current.notifications.set(request.channelId, {
          owner,
          workspaceId: request.workspaceId,
          language: request.language,
        });
      } else if (!current.notifications.has(request.channelId)) {
        throw new Error("Language service editor channel is not open");
      }
      const result = await current.manager.request(request);
      this.options.emit(
        {
          type: "workspace.language.query.response",
          payload: { requestId: request.requestId, result: result ?? null },
        },
        source,
      );
    } catch (error) {
      await registration?.release();
      this.options.emit(
        {
          type: "workspace.language.query.response",
          payload: {
            requestId: request.requestId,
            result: null,
            error: error instanceof Error ? error.message : String(error),
            errorCode: error instanceof ResponseError ? error.code : undefined,
          },
        },
        source,
      );
    }
  }

  async dispose(): Promise<void> {
    await Promise.allSettled([...this.sources.values()].map(({ manager }) => manager.dispose()));
    this.sources.clear();
  }

  async refreshProviders(): Promise<void> {
    await Promise.all([...this.sources.values()].map(({ manager }) => manager.refreshProviders()));
  }
}
