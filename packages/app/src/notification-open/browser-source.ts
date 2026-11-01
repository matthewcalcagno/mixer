import { WEB_NOTIFICATION_CLICK_EVENT } from "./model";
export interface NotificationTap {
  id: string;
  data: Record<string, unknown> | undefined;
}
export interface NotificationOpenSource {
  subscribe(onTap: (tap: NotificationTap) => void): () => void;
  takeLaunchTap(): Promise<NotificationTap | null>;
  acknowledge(tap: NotificationTap): void;
}
export function createNotificationOpenSource(): NotificationOpenSource {
  let nextId = 0;
  return {
    subscribe(onTap) {
      function receive(event: Event) {
        if (!(event instanceof CustomEvent)) return;
        event.preventDefault();
        onTap({ id: `web:${++nextId}`, data: event.detail?.data });
      }
      window.addEventListener(WEB_NOTIFICATION_CLICK_EVENT, receive);
      return () => window.removeEventListener(WEB_NOTIFICATION_CLICK_EVENT, receive);
    },
    async takeLaunchTap() {
      return null;
    },
    acknowledge() {},
  };
}
