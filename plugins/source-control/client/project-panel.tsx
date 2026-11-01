import { useCallback, useMemo, useState } from "react";
import { View } from "react-native";
import type { PluginProjectPanelProps } from "@mixer/plugin/client";
import { PaneHeader, PaneHeaderAction } from "@mixer/plugin/client/ui";
import { SourceControlPanel } from "./source-control.js";
import { SourceControlDiffPanel } from "./diff-panel.js";
import type { DiffSelection } from "./diff-selection.js";

export function ProjectSourceControlPanel({
  projectId,
  theme,
  tab,
  host,
}: PluginProjectPanelProps) {
  const scope = useMemo(() => ({ projectId }), [projectId]);
  const [selection, setSelection] = useState<DiffSelection | null>(null);
  const back = useCallback(() => setSelection(null), []);
  if (!selection)
    return <SourceControlPanel scope={scope} theme={theme} tab={tab} onOpenDiff={setSelection} />;
  return (
    <View style={frameStyle}>
      <PaneHeader title={selection.path}>
        <PaneHeaderAction icon="ArrowLeft" label="Back to Source Control" onPress={back} />
      </PaneHeader>
      <SourceControlDiffPanel
        scope={scope}
        theme={theme}
        host={host}
        tab={tab}
        selection={selection}
        onKeepOpen={keepOpen}
        readOnly
      />
    </View>
  );
}
const frameStyle = { flex: 1 };
function keepOpen() {}
