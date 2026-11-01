import { defaultWebSocketFactory } from "@mixer/client/internal/daemon-client-websocket-transport";
import type { WebSocketFactory } from "@mixer/client/internal/daemon-client-transport-types";

export function createAppWebSocketFactory(): WebSocketFactory {
  return defaultWebSocketFactory;
}
