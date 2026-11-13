export {
  SettingsSection,
  SettingsCard,
  SettingsRow,
  SettingsSwitch,
  SettingsSelect,
  SettingsInput,
  SettingsAction,
} from "@/components/settings";

export { ExternalLink } from "@/components/ui/external-link";

export { SidebarRow, SidebarSeparator } from "@/plugins/sidebar-items/kit";

export { DocumentFrame } from "@/file-panels/document-frame";

export { FilePanelLoading as Loading } from "@/file-panels/loading";

// COMPAT(pluginSettingsGroup): added in v0.13.0, remove after 2027-04-20
export { SettingsGroup } from "@/components/settings";

export { Button } from "./button";
export { Icon } from "../icons";
export { FileIcon } from "./file-icon";
export { useEditorSyntaxOptions } from "./editor-syntax";
export { ActionMenu, ContextMenu } from "./context-menu";
export { PaneHeader } from "@/components/ui/pane-content-toolbar";
export { PaneHeaderAction } from "./pane-header-action";
export { Modal } from "./modal";
export { ScrollView, FlatList } from "./scroll-view";
export { TextInput } from "./text-input";
export { copyText } from "./clipboard";
export { useToast } from "./toast";
export { StreamedText } from "./streamed-text";

export { Markdown } from "./markdown";

export { confirmDialog } from "@/utils/confirm-dialog";

export { CodeEditor } from "./code-editor";
export { SourceEditor } from "./source-editor";
export { EditorTabs } from "./editor-tabs";
export { TreeNameInput } from "./tree-name-input";
export { FileTreeRow } from "./file-tree-row";
export { TreeDragSource, TreeDropTarget } from "./tree-drag-drop";
export { SegmentedControl } from "@/components/ui/segmented-control";
export { SearchField } from "@/components/ui/search-field";
export { FormTextInput } from "@/components/ui/form-field";
export { AgentChat } from "./agent-chat";
export { FloatingAgentChat, AGENT_CHAT_LAUNCHER_CLEARANCE } from "./floating-agent-chat";
export { FloatingActionButton } from "./floating-action-button";
export { FLOATING_ACTION_BUTTON_CLEARANCE } from "@/components/ui/floating-action-button";

export {
  MainPanelIsland as WorkspaceIsland,
  WorkspaceLayout,
} from "@/components/main-panel-island";

export { WorkspaceSidebar } from "./workspace-sidebar";
export { HoverCard, HoverCardTrigger, HoverCardContent } from "@/components/ui/hover-card";

export { trashFiles } from "./trash-files";
