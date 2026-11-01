import { z } from "zod";
import type { MenuItemConstructorOptions } from "electron";

export const statusBarMenuSchema = z
  .object({
    items: z
      .array(
        z.object({
          id: z.string().min(1).max(256),
          label: z.string().min(1).max(256),
          checked: z.boolean(),
        }),
      )
      .max(1000),
  })
  .refine(
    (value) => new Set(value.items.map((item) => item.id)).size === value.items.length,
    "Duplicate status item IDs",
  );
export type StatusBarMenuRequest = z.infer<typeof statusBarMenuSchema>;
export interface StatusBarMenuResult {
  kind: "toggle-item";
  id: string;
  visible: boolean;
}

/** The renderer supplies data only, never Electron roles or executable callbacks. */
export function statusBarMenuTemplate(
  input: StatusBarMenuRequest,
  select: (result: StatusBarMenuResult) => void,
): MenuItemConstructorOptions[] {
  const entries: MenuItemConstructorOptions[] = [];
  for (const item of input.items)
    entries.push({
      label: item.label,
      type: "checkbox",
      checked: item.checked,
      click: () => select({ kind: "toggle-item", id: item.id, visible: !item.checked }),
    });
  return entries;
}
