import { Text, View } from "react-native";
import { useIsMutating, useQuery } from "@tanstack/react-query";
import { Icon } from "@mixer/plugin/client/ui";
import type { PluginIconProps } from "@mixer/plugin/client";
import type { RpcInput, RpcOutput } from "@mixer/plugin";
import { statusRpc } from "../shared/git.js";

interface SourceControlActivityIconProps extends PluginIconProps {
  workspaceId?: string;
  readStatus(input: RpcInput<typeof statusRpc>): Promise<RpcOutput<typeof statusRpc>>;
}

export function SourceControlActivityIcon({
  size,
  color,
  workspaceId,
  readStatus,
}: SourceControlActivityIconProps) {
  const key = ["source-control", workspaceId];
  const mutating = useIsMutating({ mutationKey: key }) > 0;
  // Share the panel's status query so staged and unstaged copies count as one file.
  const status = useQuery({
    queryKey: key,
    queryFn: () => {
      if (!workspaceId) throw new Error("Source Control icon requires a workspace");
      return readStatus({ workspaceId });
    },
    enabled: !!workspaceId && !mutating,
    refetchInterval: 5000,
  });
  const count = status.data?.files.length ?? 0;
  return (
    <View
      testID="source-control-activity-icon"
      style={{ width: size, height: size, position: "relative", overflow: "visible" }}
    >
      <Icon name="GitBranch" size={size} color={color} />
      {count > 0 && (
        <View
          pointerEvents="none"
          testID="source-control-change-badge"
          accessibilityLabel={`${count} uncommitted ${count === 1 ? "file" : "files"}`}
          style={{
            position: "absolute",
            right: -7,
            bottom: -6,
            minWidth: 14,
            height: 14,
            paddingHorizontal: 3,
            borderRadius: 7,
            backgroundColor: "#007acc",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Text style={{ color: "#ffffff", fontSize: 10, lineHeight: 14, fontWeight: "600" }}>
            {count > 99 ? "99+" : count}
          </Text>
        </View>
      )}
    </View>
  );
}
