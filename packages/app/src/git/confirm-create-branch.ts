import { getDesktopHost, type DesktopDialogBridge } from "@/desktop/host";
import { confirmDialog } from "@/utils/confirm-dialog";

export async function confirmCreateBranch(
  branch: string,
  dialog: Pick<DesktopDialogBridge, "askWithCheckbox"> | undefined = getDesktopHost()?.dialog,
) {
  const message = `Create a new branch named “${branch}” from the current branch?`;
  const ask = dialog?.askWithCheckbox;
  if (ask) {
    const result = await ask(message, {
      title: "Create branch",
      okLabel: "Create branch",
      cancelLabel: "Cancel",
      kind: "info",
      checkboxLabel: "Push to origin",
      checkboxChecked: false,
    });
    return { confirmed: result.confirmed, pushToOrigin: result.dontAskAgain };
  }
  const confirmed = await confirmDialog({
    title: "Create branch",
    message,
    confirmLabel: "Create branch",
    cancelLabel: "Cancel",
  });
  return { confirmed, pushToOrigin: false };
}
