import { useMemo } from "react";
import type { ButtonProps } from "@mixer/plugin/client/ui";
import { Button as HostButton } from "@/components/ui/button";
import { buttonIconSize } from "@/components/ui/control-geometry";
import { Icon } from "../icons";

/** Keep plugin actions on the same control geometry and theme tokens as the host. */
export function Button({ icon, size, ...props }: ButtonProps) {
  const leftIcon = useMemo(
    () =>
      icon
        ? (color: string) => <Icon name={icon} color={color} size={buttonIconSize[size ?? "md"]} />
        : undefined,
    [icon, size],
  );
  return <HostButton {...props} size={size} leftIcon={leftIcon} />;
}
