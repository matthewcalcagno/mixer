import { z } from "zod";
import type { MenuItemConstructorOptions } from "electron";

const actionItemSchema = z.object({
  id: z.string().min(1).max(128),
  label: z.string().min(1).max(256),
  disabled: z.boolean().optional(),
  separatorBefore: z.boolean().optional(),
  checked: z.boolean().optional(),
  accelerator: z.string().min(1).max(128).optional(),
});
const nestedActionItemSchema = actionItemSchema.extend({
  get submenu(): z.ZodOptional<z.ZodArray<typeof nestedActionItemSchema>> {
    return z.array(nestedActionItemSchema).min(1).max(1000).optional();
  },
});

const actionMenuBodySchema = z
  .object({
    kind: z.literal("actions"),
    items: z.array(nestedActionItemSchema).min(1).max(1000),
  })
  .refine((value) => {
    const ids = new Set<string>();
    function valid(items: typeof value.items, depth: number): boolean {
      if (depth > 8) return false;
      for (const item of items) {
        if (ids.has(item.id) || ids.size >= 4096) return false;
        ids.add(item.id);
        if (item.submenu && !valid(item.submenu, depth + 1)) return false;
      }
      return true;
    }
    return valid(value.items, 0);
  }, "Duplicate context action IDs or excessive menu size/depth");

function boundedMenuTree(raw: unknown): boolean {
  if (typeof raw !== "object" || raw === null) return true;
  const items: unknown = Reflect.get(raw, "items");
  if (!Array.isArray(items)) return true;
  const visited = new WeakSet<object>();
  let count = 0;
  function visit(rows: unknown[], depth: number): boolean {
    if (depth > 8 || rows.length > 1000 || visited.has(rows)) return false;
    visited.add(rows);
    count += rows.length;
    if (count > 4096) return false;
    for (const row of rows) {
      if (typeof row !== "object" || row === null) continue;
      const submenu: unknown = Reflect.get(row, "submenu");
      if (Array.isArray(submenu) && !visit(submenu, depth + 1)) return false;
    }
    return true;
  }
  return visit(items, 0);
}

export const actionContextMenuSchema = z.preprocess((raw, context) => {
  // Bound the tree before recursive parsing so malformed IPC cannot exhaust the main stack.
  if (!boundedMenuTree(raw)) {
    context.addIssue({ code: "custom", message: "Invalid native menu structure or size" });
    return z.NEVER;
  }
  return raw;
}, actionMenuBodySchema);

export type ActionContextMenuRequest = z.infer<typeof actionContextMenuSchema>;

/** Only labels and action IDs cross IPC. Renderers cannot inject Electron roles or callbacks. */
export function actionContextMenuTemplate(
  input: ActionContextMenuRequest,
  select: (id: string) => void,
): MenuItemConstructorOptions[] {
  function leaf(item: z.infer<typeof actionItemSchema>): MenuItemConstructorOptions {
    const entry: MenuItemConstructorOptions = {
      label: item.label,
      enabled: !item.disabled,
      accelerator: item.accelerator,
      registerAccelerator: false,
      click: () => {
        if (!item.disabled) select(item.id);
      },
    };
    if (item.checked !== undefined) {
      entry.type = "checkbox";
      entry.checked = item.checked;
    }
    return entry;
  }
  function build(items: ActionContextMenuRequest["items"]): MenuItemConstructorOptions[] {
    return items.flatMap((item, index) => {
      const entry: MenuItemConstructorOptions = item.submenu
        ? {
            label: item.label,
            enabled: !item.disabled,
            submenu: build(item.submenu),
          }
        : leaf(item);
      return item.separatorBefore && index > 0 ? [{ type: "separator" }, entry] : [entry];
    });
  }
  return build(input.items);
}
