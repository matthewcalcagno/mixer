import type {
  ComponentType,
  FunctionComponent,
  ReactNode,
  ForwardRefExoticComponent,
  RefAttributes,
  ReactElement,
  Ref,
} from "react";
import type {
  StyleProp,
  ViewStyle,
  ScrollView as NativeScrollView,
  ScrollViewProps,
  FlatList as NativeFlatList,
  FlatListProps,
  TextInput as NativeTextInput,
  TextInputProps,
  TextProps,
} from "react-native";
import type { PluginIconProps } from "../icons.js";
import type { PluginIcon } from "./contracts.js";

/** Host-owned frames and gutter for screens registered with presentation: "workspace". */
export declare const WorkspaceIsland: ComponentType<{
  children: ReactNode;
  testID?: string;
  variant?: "main" | "sidebar";
}>;
export declare const WorkspaceLayout: ComponentType<{ children: ReactNode; testID?: string }>;

/** Resizable Explorer-style island; participates in the user's sidebar shortcut bindings. */
export declare const WorkspaceSidebar: ComponentType<{
  children: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  compact?: boolean;
  persistenceKey: string;
  testID?: string;
}>;

export interface CodeEditorProps {
  variables?: readonly { name: string; resolved: boolean; value: string; source: string }[];
  onInspectVariable?: (name: string) => void;
  value: string;
  language: "text" | "json" | "html" | "xml" | "javascript" | "css";
  label: string;
  readOnly?: boolean;
  search?: string;
  wrap?: boolean;
  onChange?: (value: string) => void;
  onDiagnostics?: (diagnostics: readonly { message: string; line: number }[]) => void;
}
/** In-memory code buffer with host syntax colors, editor preferences, search, and JSON linting. */
export declare const CodeEditor: ComponentType<CodeEditorProps>;

export interface ButtonProps {
  children?: ReactNode;
  icon?: string;
  onPress?: () => void;
  variant?: "default" | "secondary" | "outline" | "ghost" | "destructive";
  size?: "xs" | "sm" | "md" | "lg";
  disabled?: boolean;
  loading?: boolean;
  accessibilityLabel?: string;
  testID?: string;
}
/** Host Button: shared typography, control sizing, interaction states, and theme colors. */
export declare const Button: ComponentType<ButtonProps>;

export interface ConfirmDialogOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}
/** Uses the same desktop confirmation backend as workspace and host actions. */
export declare function confirmDialog(options: ConfirmDialogOptions): Promise<boolean>;

export interface ModalProps {
  title: string;
  icon?: ReactNode;
  open: boolean;
  onOpenChange(open: boolean): void;
  children: ReactNode;
}

export interface ModalContentProps {
  children: ReactNode;
  /** Paint the full body below the header. */
  style?: StyleProp<ViewStyle>;
  /** Overrides the default 24px padding and 16px gap. Safe-area clearance stays host-owned. */
  contentContainerStyle?: StyleProp<ViewStyle>;
  /** Default true. Set false for a bounded body with your own ScrollView or FlatList. */
  scrollable?: boolean;
}

export interface ModalComponent extends FunctionComponent<ModalProps> {
  Content: ComponentType<ModalContentProps>;
}

export type ToastVariant = "default" | "info" | "success" | "warning" | "error";

export interface ToastOptions {
  variant?: ToastVariant;
  durationMs?: number;
}

export interface ToastApi {
  show(message: string, options?: ToastOptions): void;
  error(message: string): void;
}

/** Renders a Lucide icon by `name`, or any plugin icon by `icon`. An unusable icon renders nothing. */
export type IconProps = Partial<PluginIconProps> &
  ({ name: string; icon?: never } | { icon: PluginIcon; name?: never });

export declare const Icon: ComponentType<IconProps>;
export interface FileIconProps {
  fileName: string;
  size?: number;
}
/** Host file icon theme, including filename and compound-extension associations. */
export declare const FileIcon: ComponentType<FileIconProps>;
export interface EditorSyntaxOptions {
  bracketPairColorization: boolean;
}
/** Host editor syntax preferences, shared with source views rather than plugin-local defaults. */
export declare function useEditorSyntaxOptions(): EditorSyntaxOptions;
export interface PaneHeaderProps {
  title: string;
  children: ReactNode;
  testID?: string;
  titleTestID?: string;
}
/** Host-owned pane title typography, height, and action alignment, matching Files. */
export declare const PaneHeader: ComponentType<PaneHeaderProps>;
export interface PaneHeaderActionProps {
  icon: string;
  label: string;
  onPress(): void;
  disabled?: boolean;
  selected?: boolean;
  testID?: string;
}
/** The same icon size, color, button frame, and tooltip used by Files. */
export declare const PaneHeaderAction: ComponentType<PaneHeaderActionProps>;
export declare const Modal: ModalComponent;
export declare function useToast(): ToastApi;
export interface StreamedTextProps extends Omit<TextProps, "children"> {
  text: string;
  phase: "streaming" | "complete";
}
/** Plain assistant text with host-owned streaming pacing and typography. */
export declare const StreamedText: ComponentType<StreamedTextProps>;

export type { PluginIconProps } from "../icons.js";

/** React Native scrolling with the host's sheet gestures when rendered inside a sheet. */
export declare const ScrollView: ForwardRefExoticComponent<
  ScrollViewProps & RefAttributes<NativeScrollView>
>;
export declare function FlatList<Item>(
  props: FlatListProps<Item> & { ref?: Ref<NativeFlatList<Item>> },
): ReactElement;
/** Copies text to this client's clipboard. Rejects when copying is unavailable or denied. */
export declare function copyText(text: string): Promise<void>;

/** Native input focus integrated with modal keyboard positioning. */
export declare const TextInput: ForwardRefExoticComponent<
  TextInputProps & RefAttributes<NativeTextInput>
>;

export interface SettingsSectionProps {
  title: string;
  info?: ReactNode;
  trailing?: ReactNode;
  children: ReactNode;
  testID?: string;
}
export interface SettingsRowProps {
  label: string;
  hint?: string;
  error?: string | null;
  children?: ReactNode;
  testID?: string;
}
export interface SettingsSwitchProps extends SettingsRowProps {
  value: boolean;
  onValueChange(value: boolean): void;
  disabled?: boolean;
}
export interface SettingsSelectProps<Value extends string = string> extends SettingsRowProps {
  value: Value;
  options: readonly { label: string; value: Value }[];
  onValueChange(value: Value): void;
  disabled?: boolean;
}
export interface SettingsInputHandle {
  focus(): void;
  blur(): void;
  getText(): string;
  replaceText(text: string): void;
}
export interface SettingsInputProps extends SettingsRowProps {
  initialValue?: string;
  onChangeText(text: string): void;
  placeholder?: string;
  disabled?: boolean;
  secureTextEntry?: boolean;
  ref?: Ref<SettingsInputHandle>;
}
export interface SettingsActionProps extends SettingsRowProps {
  actionLabel: string;
  onPress(): void;
  disabled?: boolean;
}
// COMPAT(pluginSettingsGroup): added in v0.13.0, remove after 2027-04-20
/** @deprecated Use SettingsSection for plugin settings headings. */
export declare const SettingsGroup: ComponentType<SettingsSectionProps>;
export declare const SettingsSection: ComponentType<SettingsSectionProps>;
export declare const SettingsCard: ComponentType<{
  children: ReactNode;
  testID?: string;
  variant?: "card" | "flat";
}>;
export declare const SettingsRow: ComponentType<SettingsRowProps>;
export declare const SettingsSwitch: ComponentType<SettingsSwitchProps>;
export declare function SettingsSelect<Value extends string>(
  props: SettingsSelectProps<Value>,
): ReactNode;
export declare const SettingsInput: ComponentType<SettingsInputProps>;
export declare const SettingsAction: ComponentType<SettingsActionProps>;

export interface ExternalLinkProps {
  href: string;
  children: ReactNode;
  accessibilityLabel?: string;
  testID?: string;
  onError?: (error: unknown) => void;
}
export declare const ExternalLink: ComponentType<ExternalLinkProps>;

export type SidebarIcon = PluginIcon;
export interface SidebarRowProps {
  /**
   * Tells rows of one item apart when the item renders several: "bot-2". Unique within the item.
   * Omit it when the item renders one row.
   */
  id?: string;
  /** A Lucide icon name, inline SVG, or a component. */
  icon?: SidebarIcon;
  /** Defaults to the item's registered title. */
  label?: string;
  onPress(): void;
  active?: boolean;
  /** Right slot. Renders beside the row's pressable, so a button here presses on its own. */
  trailing?: ReactNode;
}
/** A sidebar navigation row. Render it from a sidebar item's `Component`. */
export declare const SidebarRow: ComponentType<SidebarRowProps>;
/** A line between groups of rows. Render it from a sidebar item's `Component`. */
export declare const SidebarSeparator: ComponentType;

/** Mixer's loading state. Fills the panel; the panel decides when to show it. */
export declare const Loading: ComponentType;

/** Render a local document URL in an isolated frame. */
export declare const DocumentFrame: ComponentType<{ url: string; testID?: string }>;

export interface MarkdownProps {
  children: string;
}

export interface ContextMenuAction {
  id: string;
  label: string;
  disabled?: boolean;
  separatorBefore?: boolean;
}
export interface ContextMenuProps {
  children: ReactNode;
  actions: readonly ContextMenuAction[];
  onOpen(): void;
  onSelect(id: string): void;
}
export declare const ActionMenu: ComponentType<{
  label: string;
  actions: readonly ContextMenuAction[];
  onSelect(id: string): void;
}>;

/** Native Electron context menu on desktop; the shared host menu on browser and native clients. */
export declare const ContextMenu: ComponentType<ContextMenuProps>;

/** Renders Markdown using Mixer’s theme, selection, and link behavior. */
export declare const Markdown: ComponentType<MarkdownProps>;

export declare const HoverCard: ComponentType<{ children: ReactNode; disabled?: boolean }>;
export declare const HoverCardTrigger: ComponentType<{
  children: ReactNode;
  focusable?: boolean;
  accessibilityLabel?: string;
}>;
export declare const HoverCardContent: ComponentType<{
  children: ReactNode;
  placement: "top" | "bottom" | "left" | "right";
  alignment?: "start" | "center" | "end";
}>;
