import { getDesktopHost } from "@/desktop/host";
import { getDesktopDaemonStatus } from "@/desktop/daemon/desktop-daemon";

export async function trashFiles(hostId: string, paths: string[]): Promise<void> {
  const desktop = getDesktopHost();
  if (!desktop?.dialog?.trashFiles)
    throw new Error("Update and relaunch Mixer to use Move to Trash.");
  const local = await getDesktopDaemonStatus();
  if (local.serverId !== hostId)
    throw new Error("Move to Trash is only available for files on this computer.");
  await desktop.dialog.trashFiles(paths);
}
