import { useCallback, useMemo } from "react";
import { PluginClientStateProvider } from "@mixer/plugin/client/host";
import type { PluginStatusBarItemProps } from "@mixer/plugin/client";
import type { RegisteredStatusItem } from "@/plugins/status-bar/model";
import { pluginStatusBarStore } from "@/plugins/status-bar/store";
import { PluginInstallationProvider } from "@/plugins/installation-provider";
import { SurfaceErrorBoundary } from "@/plugins/surface-error-boundary";
import { createPluginClientStateSource } from "@/plugins/client-state/source";
import { pluginIconComponent } from "@/plugins/icons";
import { useToast } from "@/contexts/toast-context";
import { useTranslation } from "react-i18next";
import { StatusEntry, CustomStatusFrame } from "./item";

interface PluginStatusProps {
  entry: RegisteredStatusItem;
  environment: PluginStatusBarItemProps;
}
export function PluginStatusItem({ entry, environment }: PluginStatusProps) {
  const stateSource = useMemo(
    () => createPluginClientStateSource(entry.installation.serverId),
    [entry.installation.serverId],
  );
  const content = entry.content;
  let body;
  let surface;
  if (content.kind === "text") {
    surface = TextStatusItem;
    body = <TextStatusItem entry={entry} environment={environment} content={content} />;
  } else {
    const Component = content.Component;
    surface = Component;
    body = (
      <CustomStatusFrame testID={`status-item-${entry.preferenceKey}`}>
        <Component {...environment} />
      </CustomStatusFrame>
    );
  }
  return (
    <SurfaceErrorBoundary installation={entry.installation} Surface={surface}>
      <PluginInstallationProvider plugin={entry.installation}>
        <PluginClientStateProvider source={stateSource}>{body}</PluginClientStateProvider>
      </PluginInstallationProvider>
    </SurfaceErrorBoundary>
  );
}
interface TextStatusProps extends PluginStatusProps {
  content: Extract<RegisteredStatusItem["content"], { kind: "text" }>;
}
function TextStatusItem({ entry, environment, content }: TextStatusProps) {
  const toast = useToast();
  const { t } = useTranslation();
  const onPress = useCallback(() => {
    void pluginStatusBarStore
      .run(entry.key)
      .catch((error: unknown) =>
        toast.error(error instanceof Error ? error.message : t("statusBar.actionError")),
      );
  }, [entry.key, toast, t]);
  const c = environment.theme.colors;
  const colors = {
    normal: c.foregroundMuted,
    warning: c.statusWarning,
    error: c.statusDanger,
    success: c.statusSuccess,
  };
  const color = colors[content.tone ?? "normal"];
  const icon = useMemo(() => {
    if (!content.icon) return undefined;
    const Icon = pluginIconComponent(content.icon);
    return <Icon {...environment} size={14} color={color} />;
  }, [content.icon, environment, color]);
  return (
    <StatusEntry
      label={content.text}
      tooltip={content.tooltip}
      color={color}
      icon={icon}
      pending={entry.pending}
      disabled={content.disabled}
      onPress={content.onPress ? onPress : undefined}
      testID={`status-item-${entry.preferenceKey}`}
    />
  );
}
