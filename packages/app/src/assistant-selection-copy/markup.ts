export const MARKDOWN_COPY_TAG_ATTRIBUTE = "data-mixer-markdown-tag";
export const MARKDOWN_COPY_IGNORE_ATTRIBUTE = "data-mixer-markdown-ignore";
export const MARKDOWN_COPY_LIST_MARKER_ATTRIBUTE = "data-mixer-markdown-list-marker";
export const MARKDOWN_COPY_UNWRAP_ATTRIBUTE = "data-mixer-markdown-unwrap";
export const MARKDOWN_COPY_LIST_START_ATTRIBUTE = "data-mixer-markdown-list-start";
export const MARKDOWN_COPY_LANGUAGE_ATTRIBUTE = "data-mixer-markdown-language";
export const MARKDOWN_COPY_ALIGN_ATTRIBUTE = "data-mixer-markdown-align";
export const MARKDOWN_COPY_SRC_ATTRIBUTE = "data-mixer-markdown-src";
export const MARKDOWN_COPY_ALT_ATTRIBUTE = "data-mixer-markdown-alt";

/**
 * Trailing line breaks, with any indentation that followed the last one.
 *
 * Both ways of copying code strip these, for the same reason: pasting a trailing
 * newline into a terminal runs the last line. A fence body always ends in one, and
 * ends in several when the author left blank lines before the closing fence; a
 * selection picks one up whenever it overshoots the end of a rendered line.
 */
export const TRAILING_CODE_LINE_BREAKS = /(\r?\n[ \t]*)+$/;

export const markdownCopyDataSet = {
  code: { mixerMarkdownTag: "code" },
  pre: { mixerMarkdownTag: "pre" },
  ignore: { mixerMarkdownIgnore: "true" },
} as const;

export function markdownCopyCodeBlockDataSet(language: string | null | undefined) {
  const fenceLanguage = language?.trim().split(/\s+/)[0];
  return {
    ...markdownCopyDataSet.pre,
    ...(fenceLanguage ? { mixerMarkdownLanguage: fenceLanguage } : {}),
  } as const;
}

export const MARKDOWN_COPY_IMAGE_SOURCES_ATTRIBUTE = "data-mixer-markdown-image-sources";
export function markdownCopyImageSourcesDataSet(sources: Record<string, string>) {
  return { mixerMarkdownImageSources: JSON.stringify(sources) };
}
