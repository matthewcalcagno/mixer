// Vendored from matthewcalcagno/mixer. See THIRD_PARTY_NOTICES.md.
import { getRawFileIconSvg, getRawFolderIconSvg } from "./material-file-icons.js";
import { desaturateHexColor } from "./color.js";

/**
 * File icons, toned to sit in our UI.
 *
 * material-icon-theme's palette is built for VS Code's file tree, where the icon is the only
 * colour on the row. Ours share a row with status dots, diff stats, and check badges, and a
 * column of them at full chroma is the loudest thing in the panel. Every colour in the vendor
 * SVG is pulled toward neutral at the same perceived lightness, so hue still tells you what the
 * file is — that is the icon's whole job — without the row competing for attention.
 *
 * One knob. If icons read as too grey or too loud, move this and nothing else; per-icon
 * overrides would put us back to hand-picking colours.
 */
const ICON_CHROMA = 0.65;

/** Anything hex-shaped. `desaturateHexColor` returns lengths it does not own untouched. */
const HEX_COLOR_PATTERN = /#[0-9a-fA-F]+/g;
// Theme build metadata is not SVG presentation. SvgXml camel-cases data-* names
// into invalid React DOM props such as dataMitNoRecolor.
const BUILD_METADATA_PATTERN = /\sdata-[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*')/g;

const toned = new Map<string, string>();

function toneSvg(svg: string): string {
  return svg.replace(HEX_COLOR_PATTERN, (hex) => desaturateHexColor(hex, ICON_CHROMA));
}

/**
 * The SVG for a file, ready to render. Results are cached by the vendor string, so the whole
 * table costs at most one pass per icon for the life of the process.
 */
export function getFileIconSvg(fileName: string): string {
  return getTonedIcon(getRawFileIconSvg(fileName));
}

export function getFolderIconSvg(options: Parameters<typeof getRawFolderIconSvg>[0]): string {
  return getTonedIcon(getRawFolderIconSvg(options));
}

function getTonedIcon(raw: string): string {
  const cached = toned.get(raw);
  if (cached !== undefined) return cached;

  const renderable = raw.replace(BUILD_METADATA_PATTERN, "");
  const next = toneSvg(renderable);
  toned.set(raw, next);
  return next;
}
