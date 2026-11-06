import { useCallback } from "react";
import type { PluginClientContext, PluginSidebarItemProps } from "@mixer/plugin/client";
import { SidebarRow } from "@mixer/plugin/client/ui";
import { ApiClientScreen } from "./client/screen.js";

function ApiClientSidebarItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  const open = useCallback(() => openScreen({ screenId: "main" }), [openScreen]);
  return (
    <SidebarRow
      icon="Network"
      label="API Client"
      active={currentScreen?.screenId === "main"}
      onPress={open}
    />
  );
}
export default function contribute(client: PluginClientContext) {
  const removeScreen = client.addScreen({
    id: "main",
    title: "API Client",
    presentation: "workspace",
    Component: ApiClientScreen,
  });
  const removeSidebar = client.addSidebarHeaderItem({
    id: "api-client",
    title: "API Client",
    Component: ApiClientSidebarItem,
  });
  return () => {
    removeSidebar();
    removeScreen();
  };
}
