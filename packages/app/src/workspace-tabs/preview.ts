import { create } from "zustand";

interface PreviewTabs {
  previews: Record<string, ReadonlySet<string>>;
  preview(workspaceKey: string, tabId: string): void;
  keepOpen(workspaceKey: string, tabId: string): void;
  forget(workspaceKey: string): void;
}

// Restored tabs are permanent. Preview lifetime belongs to the current editor session.
export const usePreviewTabs = create<PreviewTabs>((set) => ({
  previews: {},
  preview: (workspaceKey, tabId) =>
    set((state) => ({
      previews: {
        ...state.previews,
        [workspaceKey]: new Set([...(state.previews[workspaceKey] ?? []), tabId]),
      },
    })),
  keepOpen: (workspaceKey, tabId) =>
    set((state) => {
      if (!state.previews[workspaceKey]?.has(tabId)) return state;
      const tabs = new Set(state.previews[workspaceKey]);
      tabs.delete(tabId);
      return { previews: { ...state.previews, [workspaceKey]: tabs } };
    }),
  forget: (workspaceKey) =>
    set((state) => {
      if (!(workspaceKey in state.previews)) return state;
      const previews = { ...state.previews };
      delete previews[workspaceKey];
      return { previews };
    }),
}));

export function keepPreviewTabOpen(workspaceKey: string, tabId: string): void {
  usePreviewTabs.getState().keepOpen(workspaceKey, tabId);
}
