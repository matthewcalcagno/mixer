import { lazy, Suspense } from "react";
import type { AgentChatProps } from "@mixer/plugin/client/ui";
const Conversation = lazy(() => import("./agent-chat-view"));
export function AgentChat(props: AgentChatProps) {
  return (
    <Suspense fallback={null}>
      <Conversation {...props} />
    </Suspense>
  );
}
