import { getDesktopHost } from "@/desktop/host";
import { isHttpUrl } from "./http-url";
export async function openExternalUrl(url: string): Promise<void> {
  if (!isHttpUrl(url)) return;
  {
    const opener = getDesktopHost()?.opener?.openUrl;
    if (typeof opener === "function") {
      await opener(url);
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
}
