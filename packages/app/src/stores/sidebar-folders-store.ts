import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { z } from "zod";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";
import { mergeWithRemainder } from "@/utils/sidebar-reorder";

const FolderSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(200),
  collapsed: z.boolean(),
  projectKeys: z.array(z.string().min(1)),
});
const FoldersSchema = z
  .object({ folders: z.array(FolderSchema), rootOrder: z.array(z.string()).default([]) })
  .refine(({ folders }) => {
    const ids = folders.map((folder) => folder.id);
    const keys = folders.flatMap((folder) => folder.projectKeys);
    return new Set(ids).size === ids.length && new Set(keys).size === keys.length;
  });
export type SidebarFolder = z.infer<typeof FolderSchema>;
type FolderState = Pick<z.infer<typeof FoldersSchema>, "folders">;

export function resolveSidebarRootKeys({
  folders,
  projectKeys,
  order,
}: {
  folders: SidebarFolder[];
  projectKeys: string[];
  order: string[];
}): string[] {
  const assigned = new Set(folders.flatMap((folder) => folder.projectKeys));
  const keys = [
    ...folders.map((folder) => `folder:${folder.id}`),
    ...projectKeys.filter((key) => !assigned.has(key)),
  ];
  const available = new Set(keys);
  return [
    ...order.filter((key) => available.delete(key)),
    ...keys.filter((key) => available.delete(key)),
  ];
}

export function insertSidebarRootKey({
  keys,
  key,
  target,
  placement,
}: {
  keys: string[];
  key: string;
  target: string;
  placement: "before" | "after";
}): string[] {
  if (key === target || !keys.includes(target)) return keys;
  const next = keys.filter((entry) => entry !== key);
  const index = next.indexOf(target) + (placement === "after" ? 1 : 0);
  next.splice(index, 0, key);
  return next;
}
type FolderAction =
  | { kind: "create"; id: string; name: string }
  | { kind: "rename"; id: string; name: string }
  | { kind: "remove" | "toggle"; id: string }
  | { kind: "move"; projectKey: string; folderId: string | null };

export function reduceSidebarFolders(state: FolderState, action: FolderAction): FolderState {
  switch (action.kind) {
    case "create":
      if (state.folders.some((folder) => folder.id === action.id)) return state;
      return {
        folders: [
          ...state.folders,
          FolderSchema.parse({
            id: action.id,
            name: action.name,
            collapsed: false,
            projectKeys: [],
          }),
        ],
      };
    case "rename": {
      const name = FolderSchema.shape.name.parse(action.name);
      return {
        folders: state.folders.map((folder) =>
          folder.id === action.id ? { ...folder, name } : folder,
        ),
      };
    }
    case "remove":
      return { folders: state.folders.filter((folder) => folder.id !== action.id) };
    case "toggle":
      return {
        folders: state.folders.map((folder) =>
          folder.id === action.id ? { ...folder, collapsed: !folder.collapsed } : folder,
        ),
      };
    case "move":
      if (
        action.folderId !== null &&
        !state.folders.some((folder) => folder.id === action.folderId)
      )
        return state;
      return {
        folders: state.folders.map((folder) => {
          const projectKeys = folder.projectKeys.filter((key) => key !== action.projectKey);
          if (folder.id === action.folderId) projectKeys.push(action.projectKey);
          return {
            ...folder,
            projectKeys,
            collapsed: folder.id === action.folderId ? false : folder.collapsed,
          };
        }),
      };
  }
}

interface SidebarFoldersState extends FolderState {
  rootOrder: string[];
  setRootOrder: (keys: string[]) => void;
  editingId: string | null;
  createFolder: () => void;
  renameFolder: (id: string, name: string) => void;
  removeFolder: (id: string) => void;
  toggleFolder: (id: string) => void;
  moveProject: (projectKey: string, folderId: string | null) => void;
  editFolder: (id: string | null) => void;
}

export const useSidebarFoldersStore = create<SidebarFoldersState>()(
  persist(
    (set) => ({
      folders: [],
      rootOrder: [],
      setRootOrder: (keys) =>
        set((state) => ({
          rootOrder: mergeWithRemainder({
            currentOrder: state.rootOrder,
            reorderedVisibleKeys: keys,
          }),
        })),
      editingId: null,
      createFolder: () => {
        const id = crypto.randomUUID();
        set((state) => ({
          ...reduceSidebarFolders(state, { kind: "create", id, name: "New folder" }),
          editingId: id,
        }));
      },
      renameFolder: (id, name) =>
        set((state) => reduceSidebarFolders(state, { kind: "rename", id, name })),
      removeFolder: (id) =>
        set((state) => ({
          ...reduceSidebarFolders(state, { kind: "remove", id }),
          editingId: null,
        })),
      toggleFolder: (id) => set((state) => reduceSidebarFolders(state, { kind: "toggle", id })),
      moveProject: (projectKey, folderId) =>
        set((state) => reduceSidebarFolders(state, { kind: "move", projectKey, folderId })),
      editFolder: (editingId) => set({ editingId }),
    }),
    {
      name: "sidebar-project-folders",
      storage: createValidatedPersistStorage(AsyncStorage, FoldersSchema),
      partialize: (state) => ({ folders: state.folders, rootOrder: state.rootOrder }),
    },
  ),
);
