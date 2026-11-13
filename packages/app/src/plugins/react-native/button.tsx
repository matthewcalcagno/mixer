import { useMemo } from "react";
import type { ButtonProps } from "@mixer/plugin/client/ui";
import { Button as HostButton } from "@/components/ui/button";
import { buttonIconSize } from "@/components/ui/control-geometry";
import { Icon } from "../icons";

/** Keep plugin actions on the same control geometry and theme tokens as the host. */
export function Button({ icon, size, flushStart, ...props }: ButtonProps) {
  const frameStyle = useMemo(() => {
    if (!flushStart) return undefined;
    // ChevronLeft's tip starts at x=9 in its 24px viewBox. Align its ink, not its SVG box.
    const iconInset = icon === "ChevronLeft" ? (buttonIconSize[size ?? "md"] * 9) / 24 : 0;
    return { paddingLeft: 0, marginLeft: -1 - iconInset };
  }, [flushStart, icon, size]);
  const leftIcon = useMemo(
    () =>
      icon
        ? (color: string) => <Icon name={icon} color={color} size={buttonIconSize[size ?? "md"]} />
        : undefined,
    [icon, size],
  );
  return <HostButton {...props} size={size} leftIcon={leftIcon} style={frameStyle} />;
}
