import { getIsElectronRuntimeMac } from "@/constants/layout";
import type { ShortcutOs } from "@/utils/format-shortcut";
import { isMacUserAgent } from "@/utils/mac-user-agent";
export function getShortcutOs(): ShortcutOs {
  if (getIsElectronRuntimeMac()) return "mac";
  return isMacUserAgent() ? "mac" : "non-mac";
}
