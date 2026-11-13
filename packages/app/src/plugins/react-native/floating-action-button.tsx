import type { ComponentProps } from "react";
import type { FloatingActionButton as PluginButton } from "@mixer/plugin/client/ui";
import { FloatingActionButton as HostButton } from "@/components/ui/floating-action-button";
import { pluginIconComponent } from "../icons";

export function FloatingActionButton({ icon, ...props }: ComponentProps<typeof PluginButton>) {
  return <HostButton {...props} icon={pluginIconComponent(icon)} />;
}
