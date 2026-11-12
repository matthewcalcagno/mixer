import { useCallback } from "react";
import type { PluginClientContext, PluginSidebarItemProps } from "@mixer/plugin/client";
import { SidebarRow } from "@mixer/plugin/client/ui";
import { AutomationsScreen, AutomationsSettings } from "./client/screen.js";

function AutomationsSidebarItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  const open = useCallback(() => openScreen({ screenId: "workflows" }), [openScreen]);
  return (
    <SidebarRow
      icon="Workflow"
      label="Automations"
      active={currentScreen?.screenId === "workflows"}
      onPress={open}
    />
  );
}

export default function contribute(client: PluginClientContext) {
  const screen = client.addScreen({
    id: "workflows",
    title: "Automations",
    Component: AutomationsScreen,
  });
  const sidebar = client.addSidebarHeaderItem({
    id: "automations",
    title: "Automations",
    Component: AutomationsSidebarItem,
  });
  const settings = client.addSettingsScreen({
    id: "preferences",
    title: "Automations",
    icon: "Workflow",
    Component: AutomationsSettings,
  });
  return () => {
    settings();
    sidebar();
    screen();
  };
}
