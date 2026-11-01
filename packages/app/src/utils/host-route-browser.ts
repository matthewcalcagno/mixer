import { stripHostWorkspaceRouteEchoSearch } from "@/utils/host-routes";
function getCurrentBrowserRoute(): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}
export function replaceBrowserRouteWithCanonicalHostWorkspaceRoute(route: string): void {
  if (typeof window === "undefined") {
    return;
  }
  window.history.replaceState(null, "", stripHostWorkspaceRouteEchoSearch(route));
}
export function stripHostWorkspaceRouteEchoSearchFromBrowserUrl(): void {
  const currentRoute = getCurrentBrowserRoute();
  if (!currentRoute) {
    return;
  }
  const canonicalRoute = stripHostWorkspaceRouteEchoSearch(currentRoute);
  if (canonicalRoute === currentRoute) {
    return;
  }
  window.history.replaceState(null, "", canonicalRoute);
}
export function stripHostWorkspaceRouteEchoSearchFromBrowserUrlAfterCommit(): void {
  if (typeof window === "undefined") {
    return;
  }
  window.setTimeout(stripHostWorkspaceRouteEchoSearchFromBrowserUrl, 0);
}
