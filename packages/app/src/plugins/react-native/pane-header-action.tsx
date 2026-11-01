import type { PaneHeaderActionProps } from "@mixer/plugin/client/ui";
import { withUnistyles } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import { extraMutedIconColorMapping } from "@/components/ui/icon-color";
import { ToolbarButton, paneContentToolbarIconSize } from "@/components/ui/pane-content-toolbar";
import { Icon } from "../icons";

const ThemedIcon = withUnistyles(Icon);

export function PaneHeaderAction({
  icon,
  label,
  onPress,
  disabled,
  selected,
  testID,
}: PaneHeaderActionProps) {
  const compact = useIsCompactFormFactor();
  return (
    <ToolbarButton
      label={label}
      onPress={onPress}
      disabled={disabled}
      selected={selected}
      testID={testID}
      compact={compact}
      hitSlop={8}
    >
      <ThemedIcon
        name={icon}
        size={paneContentToolbarIconSize(compact)}
        uniProps={extraMutedIconColorMapping}
      />
    </ToolbarButton>
  );
}
