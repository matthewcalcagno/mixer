import type { FileIconProps } from "@mixer/plugin/client/ui";
import { MaterialFileIcon } from "@/components/material-file-icon";

export function FileIcon({ fileName, size = 16 }: FileIconProps) {
  return <MaterialFileIcon fileName={fileName} size={size} />;
}
