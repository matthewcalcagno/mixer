import { router } from "expo-router";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Settings } from "lucide-react-native";
import { buildSettingsSectionRoute, SETTINGS_SECTION_SLUGS } from "@/utils/host-routes";
import { clearCommandCenterFocusRestoreElement } from "@/utils/command-center-focus-restore";
import { getCommandCenterIcon } from "./icon";
import type { CommandCenterContribution } from "./contributions";

const SettingsIcon = getCommandCenterIcon(Settings);

const keywords: Partial<Record<(typeof SETTINGS_SECTION_SLUGS)[number], readonly string[]>> = {
  appearance: ["theme", "dark mode", "interface size", "colors", "font family", "zoom"],
  editor: ["font size", "ligatures", "minimap", "indentation", "word wrap", "line numbers"],
  files: ["explorer", "hidden files", "preview", "sort"],
  shortcuts: ["keyboard", "keybindings", "hotkeys"],
  integrations: ["plugins", "extensions", "providers"],
  permissions: ["approval", "sandbox"],
  diagnostics: ["logs", "troubleshooting"],
  about: ["version", "updates", "release channel", "changelog"],
};

export function useSearchSettings() {
  const { t } = useTranslation();
  return useMemo(
    () =>
      SETTINGS_SECTION_SLUGS.map<CommandCenterContribution>((section, rank) => ({
        id: `search-setting:${section}`,
        group: "settings-search",
        groupRank: 2,
        rank,
        visibility: "always",
        keywords: [t("settings.title"), ...(keywords[section] ?? [])],
        presentation: {
          kind: "action",
          title: t(`settings.sections.${section}`),
          sectionTitle: t("settings.title"),
          icon: SettingsIcon,
        },
        run() {
          clearCommandCenterFocusRestoreElement();
          router.push(buildSettingsSectionRoute(section));
        },
      })),
    [t],
  );
}
