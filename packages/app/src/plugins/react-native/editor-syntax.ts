import { useMemo } from "react";
import type { EditorSyntaxOptions } from "@mixer/plugin/client/ui";
import { useAppSettings } from "@/hooks/use-settings";

export function useEditorSyntaxOptions(): EditorSyntaxOptions {
  const { settings } = useAppSettings();
  return useMemo(
    () => ({ bracketPairColorization: settings.editor.rainbowBrackets }),
    [settings.editor.rainbowBrackets],
  );
}
