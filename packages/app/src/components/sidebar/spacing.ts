import type { Theme } from "@/styles/theme";
import { density } from "@/styles/density";
import {
  WORKSPACE_TREE_ICON_SIZE,
  WORKSPACE_TREE_ICON_LABEL_GAP,
} from "@/components/tree-primitives";

export function sidebarSpacing({ spacing }: Pick<Theme, "spacing">) {
  const treeInset = -spacing[0.5];
  const row = {
    minHeight: { xs: density.rowHeight.xs, md: spacing[7] },
    paddingVertical: { xs: spacing[2], md: spacing[1] },
    paddingLeft: spacing[2],
    paddingRight: { xs: spacing[3], md: spacing[2] },
    marginBottom: spacing[0.5],
  };
  return {
    treeInset,
    row,
    groupHeader: { ...row, paddingRight: spacing[2] },
    treeHeader: {
      ...row,
      paddingLeft: treeInset + WORKSPACE_TREE_ICON_SIZE + WORKSPACE_TREE_ICON_LABEL_GAP,
      paddingRight: spacing[2],
    },
    indent: { xs: spacing[4], md: spacing[3] },
    groupEnd: { paddingBottom: { xs: spacing[3], md: spacing[1.5] } },
    titleMetadata: { gap: spacing[0.5] },
  };
}
