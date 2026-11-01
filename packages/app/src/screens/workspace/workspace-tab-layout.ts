export type WorkspaceTabCloseButtonPolicy = "all" | "none";
export type WorkspaceTabSizing =
  | { kind: "shrink" }
  | { kind: "fit"; maxWidth: number; trailingWidth: number };

export interface WorkspaceTabLayoutMetrics {
  rowHorizontalInset: number;
  actionsReservedWidth: number;
  rowPaddingHorizontal: number;
  tabGap: number;
  minTabWidth: number;
  maxTabWidth: number;
  tabIconWidth: number;
  tabContentGap: number;
  tabHorizontalPadding: number;
  closeButtonWidth: number;
}

export interface WorkspaceTabLayoutInput {
  viewportWidth: number;
  tabLabelWidths: number[];
  tabSizing?: readonly WorkspaceTabSizing[];
  shrinkToFit?: boolean;
  metrics: WorkspaceTabLayoutMetrics;
  /**
   * Compact layouts are touch-first. Tabs keep their natural width and the row scrolls as soon as
   * they overflow, so a label is never squeezed to make room; chips carry no inline close because a
   * narrow X beside the label is easy to hit by accident and the tab's long-press menu closes it.
   */
  compact: boolean;
}

export interface WorkspaceTabLayoutItem {
  width: number;
  showLabel: boolean;
}

export interface WorkspaceTabLayoutResult {
  items: WorkspaceTabLayoutItem[];
  closeButtonPolicy: WorkspaceTabCloseButtonPolicy;
  requiresHorizontalScrollFallback: boolean;
}

export function retainWorkspaceTabMeasuredWidth(
  currentWidth: number,
  measuredWidth: number,
): number {
  if (measuredWidth <= 0 || Math.abs(currentWidth - measuredWidth) <= 1) {
    return currentWidth;
  }
  return measuredWidth;
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}

export function computeWorkspaceTabLayout(
  input: WorkspaceTabLayoutInput,
): WorkspaceTabLayoutResult {
  const tabCount = input.tabLabelWidths.length;
  const closeButtonPolicy: WorkspaceTabCloseButtonPolicy = input.compact ? "none" : "all";
  if (tabCount === 0) {
    return {
      items: [],
      closeButtonPolicy,
      requiresHorizontalScrollFallback: false,
    };
  }

  const availableWidth = Math.max(
    0,
    input.viewportWidth - input.metrics.rowHorizontalInset * 2 - input.metrics.actionsReservedWidth,
  );
  const rowOverhead =
    input.metrics.rowPaddingHorizontal * 2 + Math.max(tabCount - 1, 0) * input.metrics.tabGap;
  const availableTabsWidth = Math.max(0, availableWidth - rowOverhead);
  const tabChromeWidth =
    input.metrics.tabIconWidth +
    input.metrics.tabContentGap +
    input.metrics.tabHorizontalPadding * 2 +
    input.metrics.closeButtonWidth;
  const maximumWidths = input.tabLabelWidths.map((_, index) => {
    const sizing = input.tabSizing?.[index];
    return sizing?.kind === "fit" ? sizing.maxWidth : input.metrics.maxTabWidth;
  });
  const naturalWidths = input.tabLabelWidths.map((labelWidth, index) => {
    const sizing = input.tabSizing?.[index];
    const trailingWidth = sizing?.kind === "fit" ? sizing.trailingWidth : 0;
    return clamp(
      tabChromeWidth + labelWidth + trailingWidth,
      input.metrics.minTabWidth,
      maximumWidths[index],
    );
  });
  const minimumWidths = naturalWidths.map((width, index) =>
    input.tabSizing?.[index]?.kind === "fit" ? width : input.metrics.minTabWidth,
  );
  const naturalTotalWidth = naturalWidths.reduce((total, width) => total + width, 0);
  const minimumTotalWidth = minimumWidths.reduce((total, width) => total + width, 0);
  // A row that scrolls has no reason to truncate: the tabs keep their natural widths and the
  // viewport pans over them. Fit-to-content tabs retain their names; only other pointer-layout
  // tabs shrink toward the clickable minimum. Compact layouts skip the shrink entirely.
  const requiresHorizontalScrollFallback =
    input.compact || input.shrinkToFit === false
      ? naturalTotalWidth > availableTabsWidth
      : availableTabsWidth < minimumTotalWidth;

  let resolvedWidths = naturalWidths;
  if (
    !requiresHorizontalScrollFallback &&
    !input.compact &&
    naturalTotalWidth > availableTabsWidth
  ) {
    const widthToRemove = naturalTotalWidth - availableTabsWidth;
    const shrinkCapacity = naturalTotalWidth - minimumTotalWidth;
    const shrinkRatio = widthToRemove / shrinkCapacity;
    resolvedWidths = naturalWidths.map(
      (width, index) => width - (width - minimumWidths[index]) * shrinkRatio,
    );
  }

  const roundedWidths = resolvedWidths.map((width, index) =>
    Math.round(clamp(width, input.metrics.minTabWidth, maximumWidths[index])),
  );

  return {
    items: roundedWidths.map((width) => ({
      width,
      showLabel: width > tabChromeWidth,
    })),
    closeButtonPolicy,
    requiresHorizontalScrollFallback,
  };
}
