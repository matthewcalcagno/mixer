import { create } from "zustand";

export const useDesktopWindowTitle = create(() => ({ title: "Mixer" }));

export function formatDesktopWindowTitle(label: string, workspace: string): string {
  const title = label.trim();
  const name = workspace.trim();
  return title && name && title !== name ? `${title} — ${name}` : title || name || "Mixer";
}
