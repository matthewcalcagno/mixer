import { SPACING } from "@/styles/theme";

export const FILE_EXPLORER_INDENT = SPACING[2];
const ROOT_INSET = SPACING[3];

export function fileExplorerRowPaddingLeft(depth: number): number {
  return ROOT_INSET + depth * FILE_EXPLORER_INDENT;
}

export function fileExplorerRowMetrics(fontSize: number) {
  return {
    minHeight: Math.round((22 * fontSize) / 13),
    lineHeight: Math.round((18 * fontSize) / 13),
  };
}
