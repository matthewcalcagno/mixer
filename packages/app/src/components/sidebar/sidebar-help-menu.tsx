import { useCallback, useEffect, useState } from "react";
import { Text, View } from "react-native";
import { Activity, CircleHelp, Gift, Keyboard } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { DiscordIcon } from "@/components/icons/discord-icon";
import { GitHubIcon } from "@/components/icons/github-icon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuHint,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DensityIcon } from "@/components/ui/density-icon";
import { SidebarFooterIconHighlight } from "./sidebar-footer-icon-highlight";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAppDiagnosticStore } from "@/diagnostics/store";
import { useKeyboardShortcutsAvailable } from "@/keyboard/availability";
import {
  useHostRuntimeIsConnected,
  useHosts,
  getHostRuntimeStore,
  isHostRuntimeConnected,
} from "@/runtime/host-runtime";
import { getIsElectron } from "@/constants/platform";
import { getDesktopHost } from "@/desktop/host";
import { useKeyboardShortcutsStore } from "@/stores/keyboard-shortcuts-store";
import { useSessionStore } from "@/stores/session-store";
import { density } from "@/styles/density";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import type { HostProfile } from "@/types/host-connection";
import { formatVersionWithPrefix } from "@/desktop/updates/desktop-updates";
import { resolveAppVersion } from "@/utils/app-version";
import { openChangelog } from "@/changelog";
import { openExternalUrl } from "@/utils/open-external-url";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";

const DISCORD_URL = "https://discord.gg/jz8T2uahpH";
const GITHUB_ISSUE_URL = "https://github.com/matthewcalcagno/mixer/issues/new";
const ThemedActivity = withUnistyles(Activity);
const ThemedGift = withUnistyles(Gift);
const ThemedKeyboard = withUnistyles(Keyboard);
const ThemedCircleHelp = withUnistyles(CircleHelp);
const ThemedDiscordIcon = withUnistyles(DiscordIcon);
const ThemedGitHubIcon = withUnistyles(GitHubIcon);
const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});
const diagnosticLeadingIcon = (
  <ThemedActivity size={ICON_SIZE.sm} uniProps={foregroundMutedColorMapping} />
);
const shortcutsLeadingIcon = (
  <ThemedKeyboard size={ICON_SIZE.sm} uniProps={foregroundMutedColorMapping} />
);
const discordLeadingIcon = (
  <ThemedDiscordIcon size={ICON_SIZE.sm} uniProps={foregroundMutedColorMapping} />
);
const githubLeadingIcon = (
  <ThemedGitHubIcon size={ICON_SIZE.sm} uniProps={foregroundMutedColorMapping} />
);
const changelogLeadingIcon = (
  <ThemedGift size={ICON_SIZE.sm} uniProps={foregroundMutedColorMapping} />
);

function HostVersionHint({ host }: { host: HostProfile }) {
  const { t } = useTranslation();
  const isConnected = useHostRuntimeIsConnected(host.serverId);
  const daemonVersion = useSessionStore(
    (state) => state.sessions[host.serverId]?.serverInfo?.version ?? null,
  );
  const version = isConnected
    ? formatVersionWithPrefix(daemonVersion)
    : t("settings.about.offline");

  return (
    <DropdownMenuHint
      style={styles.versionHint}
      trailing={version}
      testID={`sidebar-help-host-version-${host.serverId}`}
    >
      {host.label}
    </DropdownMenuHint>
  );
}

export function SidebarHelpMenu({ placement = "footer" }: { placement?: "footer" | "titlebar" }) {
  return getIsElectron() ? null : <SidebarHelpPopup placement={placement} />;
}

export function ApplicationHelpMenu() {
  return getIsElectron() ? <NativeHelpMenuRegistration /> : null;
}

function NativeHelpMenuRegistration() {
  const { t } = useTranslation();
  const hosts = useHosts();
  const shortcutsAvailable = useKeyboardShortcutsAvailable();
  const openAppDiagnostic = useAppDiagnosticStore((state) => state.open);
  const setShortcutsDialogOpen = useKeyboardShortcutsStore((state) => state.setShortcutsDialogOpen);

  useEffect(() => {
    const desktop = getDesktopHost();
    const runtime = getHostRuntimeStore();
    let previousMenu = "";
    const update = () => {
      const sessions = useSessionStore.getState().sessions;
      const menu = {
        kind: "actions" as const,
        items: [
          ...(shortcutsAvailable ? [{ id: "shortcuts", label: t("sidebar.help.shortcuts") }] : []),
          { id: "changelog", label: t("sidebar.help.whatsNew") },
          { id: "diagnostics", label: t("sidebar.help.diagnostics") },
          {
            id: "report",
            label: t("sidebar.help.reportIssue"),
            disabled: true,
            separatorBefore: true,
          },
          { id: "discord", label: t("sidebar.help.discord") },
          { id: "github", label: t("sidebar.help.github") },
          {
            id: "version",
            label:
              `${t("sidebar.help.appName")} ${formatVersionWithPrefix(resolveAppVersion())}`.trim(),
            disabled: true,
            separatorBefore: true,
          },
          ...hosts.map((host) => ({
            id: `host-${host.serverId}`,
            label: `${host.label} ${
              isHostRuntimeConnected(runtime.getSnapshot(host.serverId))
                ? formatVersionWithPrefix(sessions[host.serverId]?.serverInfo?.version ?? null)
                : t("settings.about.offline")
            }`.trim(),
            disabled: true,
          })),
        ],
      };
      const serialized = JSON.stringify(menu);
      if (serialized === previousMenu) return;
      previousMenu = serialized;
      void desktop?.menu?.setHelpMenu?.(menu);
    };
    const subscription = desktop?.events?.on?.("help-menu-action", (action) => {
      switch (action) {
        case "shortcuts":
          setShortcutsDialogOpen(true);
          break;
        case "changelog":
          openChangelog();
          break;
        case "diagnostics":
          openAppDiagnostic();
          break;
        case "discord":
          void openExternalUrl(DISCORD_URL);
          break;
        case "github":
          void openExternalUrl(GITHUB_ISSUE_URL);
          break;
      }
    });
    update();
    const unsubscribers = [
      useSessionStore.subscribe((state, previous) => {
        if (
          hosts.some(
            (host) =>
              state.sessions[host.serverId]?.serverInfo?.version !==
              previous.sessions[host.serverId]?.serverInfo?.version,
          )
        )
          update();
      }),
      ...hosts.map((host) => runtime.subscribe(host.serverId, update)),
    ];
    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
      if (typeof subscription === "function") subscription();
      else void subscription?.then((unsubscribe) => unsubscribe());
      void desktop?.menu?.setHelpMenu?.(null);
    };
  }, [hosts, t, shortcutsAvailable, openAppDiagnostic, setShortcutsDialogOpen]);
  return null;
}

function SidebarHelpPopup({ placement }: { placement: "footer" | "titlebar" }) {
  const { t } = useTranslation();
  const shortcutsAvailable = useKeyboardShortcutsAvailable();
  const openAppDiagnostic = useAppDiagnosticStore((state) => state.open);
  const setShortcutsDialogOpen = useKeyboardShortcutsStore((state) => state.setShortcutsDialogOpen);
  const [open, setOpen] = useState(false);
  const version = formatVersionWithPrefix(resolveAppVersion());
  const hosts = useHosts();

  const openKeyboardShortcuts = useCallback(() => {
    setShortcutsDialogOpen(true);
  }, [setShortcutsDialogOpen]);

  const openDiscord = useCallback(() => {
    void openExternalUrl(DISCORD_URL);
  }, []);

  const openGitHubIssue = useCallback(() => {
    void openExternalUrl(GITHUB_ISSUE_URL);
  }, []);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      {placement === "titlebar" ? (
        <ToolbarButton
          kind="menu"
          label={t("sidebar.help.trigger")}
          selected={open}
          testID="sidebar-help"
        >
          <ThemedCircleHelp size={ICON_SIZE.md} uniProps={foregroundMutedColorMapping} />
        </ToolbarButton>
      ) : (
        <Tooltip delayDuration={300} enabledOnDesktop={!open}>
          <TooltipTrigger asChild>
            <View>
              <DropdownMenuTrigger
                style={styles.trigger}
                testID="sidebar-help"
                accessibilityRole="button"
                accessibilityLabel={t("sidebar.help.trigger")}
              >
                {({ hovered, pressed, open: menuOpen }) => (
                  <>
                    <SidebarFooterIconHighlight visible={pressed || menuOpen} />
                    <DensityIcon
                      icon={CircleHelp}
                      size="md"
                      color={hovered ? "foreground" : "foregroundMuted"}
                    />
                  </>
                )}
              </DropdownMenuTrigger>
            </View>
          </TooltipTrigger>
          <TooltipContent side="top" align="center" offset={8}>
            <Text style={styles.tooltipText}>{t("sidebar.help.trigger")}</Text>
          </TooltipContent>
        </Tooltip>
      )}
      <DropdownMenuContent
        side={placement === "titlebar" ? "bottom" : "top"}
        align="end"
        offset={8}
        width={280}
        testID="sidebar-help-menu"
      >
        <DropdownMenuLabel>{t("sidebar.help.sectionHelp")}</DropdownMenuLabel>
        {shortcutsAvailable ? (
          <DropdownMenuItem
            testID="sidebar-help-shortcuts"
            leading={shortcutsLeadingIcon}
            onSelect={openKeyboardShortcuts}
          >
            {t("sidebar.help.shortcuts")}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem
          testID="sidebar-help-changelog"
          leading={changelogLeadingIcon}
          onSelect={openChangelog}
        >
          {t("sidebar.help.whatsNew")}
        </DropdownMenuItem>
        <DropdownMenuItem
          testID="sidebar-help-diagnostics"
          leading={diagnosticLeadingIcon}
          onSelect={openAppDiagnostic}
        >
          {t("sidebar.help.diagnostics")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>{t("sidebar.help.reportIssue")}</DropdownMenuLabel>
        <DropdownMenuItem
          testID="sidebar-help-discord"
          leading={discordLeadingIcon}
          onSelect={openDiscord}
        >
          {t("sidebar.help.discord")}
        </DropdownMenuItem>
        <DropdownMenuItem
          testID="sidebar-help-github"
          leading={githubLeadingIcon}
          onSelect={openGitHubIssue}
        >
          {t("sidebar.help.github")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <View style={styles.versionList}>
          <DropdownMenuHint
            style={styles.versionHint}
            trailing={version}
            testID="sidebar-help-version"
          >
            {t("sidebar.help.appName")}
          </DropdownMenuHint>
          {hosts.map((host) => (
            <HostVersionHint key={host.serverId} host={host} />
          ))}
        </View>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const styles = StyleSheet.create((theme) => ({
  trigger: {
    width: density.iconButton,
    height: density.iconButton,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[1],
  },
  tooltipText: {
    fontSize: theme.fontSize.chrome,
    color: theme.colors.popoverForeground,
  },
  versionList: {
    gap: theme.spacing[1],
    paddingVertical: theme.spacing[2],
  },
  versionHint: {
    paddingVertical: 0,
  },
}));
