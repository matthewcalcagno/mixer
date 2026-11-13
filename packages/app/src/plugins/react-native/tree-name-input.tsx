import type { ComponentProps } from "react";
import type { TreeNameInput as PluginInput } from "@mixer/plugin/client/ui";

export function TreeNameInput({ depth = 0, ...props }: ComponentProps<typeof PluginInput>) {
  const { EntryNameInputRow } =
    require("@/components/file-explorer-pane") as typeof import("@/components/file-explorer-pane");
  return <EntryNameInputRow {...props} depth={depth} />;
}
