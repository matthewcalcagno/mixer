import type { RefObject } from "react";
import type { FilePanelOpenWithMenu } from "@/file-panels/choice/open-with";
import type { WorkspaceTabMenuEntry } from "./workspace-tab-menu";

export interface NativeTabContextMenuInput {
  ref: RefObject<unknown>;
  entries: readonly WorkspaceTabMenuEntry[];
  openWith: FilePanelOpenWithMenu["nativeMenu"];
}
