import type { PluginClientContext } from "@mixer/plugin/client";
import { SearchPanel, ProjectSearchPanel } from "./client/panel.js";

export default function contribute(client: PluginClientContext) {
  client.addWorkspacePanel({
    id: "search",
    title: "Search",
    icon: "Search",
    context: "workspace",
    locations: ["explorer"],
    Component: SearchPanel,
    ProjectComponent: ProjectSearchPanel,
  });
  client.addCommandCenterItem({
    id: "find-in-files",
    title: "Search in files",
    icon: "Search",
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("search", { location: "explorer" });
    },
  });
  return () => {};
}
