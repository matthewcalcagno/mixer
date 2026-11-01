import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { FolderOpen } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { ContextMenuItem } from "@/components/ui/context-menu";
import { getIsElectron } from "@/constants/platform";
import { useToast } from "@/contexts/toast-context";
import type { Theme } from "@/styles/theme";
import { openDesktopTarget, useDesktopOpenTargets } from "@/workspace/desktop-open-targets";
import { useNativeMenuResource } from "@/components/ui/menu/native-menu";

interface OpenInFileManagerMenuItemProps {
  path?: string | null;
  testID: string;
  surface?: "context" | "dropdown";
}

const ThemedFolderOpen = withUnistyles(FolderOpen);

const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

const leadingIcon = <ThemedFolderOpen size={14} uniProps={foregroundMutedColorMapping} />;

export function OpenInFileManagerMenuItem({
  path,
  testID,
  surface = "dropdown",
}: OpenInFileManagerMenuItemProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const isElectron = getIsElectron();
  const workspacePath = path?.trim() ?? "";
  const { targets, isLoading } = useDesktopOpenTargets({
    isLocalExecution: isElectron && workspacePath.length > 0,
  });
  useNativeMenuResource(Boolean(isLoading));
  const fileManagerTarget = targets.find((target) => target.kind === "file-manager");

  const openInFileManager = useCallback(() => {
    if (!fileManagerTarget || workspacePath.length === 0) return;
    void openDesktopTarget({
      editorId: fileManagerTarget.id,
      workspacePath,
    }).catch((error) => {
      console.warn("[open-in-file-manager] open failed", error);
      toast.error(t("sidebar.project.actions.openFolderFailed"));
    });
  }, [fileManagerTarget, t, toast, workspacePath]);

  if (!isElectron || (!fileManagerTarget && !isLoading) || workspacePath.length === 0) {
    return null;
  }

  const label = t("sidebar.project.actions.openFolder");
  if (surface === "context") {
    return (
      <ContextMenuItem
        disabled={!fileManagerTarget}
        testID={testID}
        leading={leadingIcon}
        onSelect={openInFileManager}
      >
        {label}
      </ContextMenuItem>
    );
  }
  return (
    <DropdownMenuItem
      disabled={!fileManagerTarget}
      testID={testID}
      leading={leadingIcon}
      onSelect={openInFileManager}
    >
      {label}
    </DropdownMenuItem>
  );
}
