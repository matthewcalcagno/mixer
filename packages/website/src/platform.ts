import { createServerFn } from "@tanstack/react-start";
import { getRequestHeader } from "@tanstack/react-start/server";

export type DesktopPlatform = "mac" | "windows" | "linux";
export type VisitorPlatform = DesktopPlatform | "unknown";

/**
 * Order matters: Android user agents also say "Linux", and iOS ones also say
 * "like Mac OS X". iPadOS Safari sends a desktop Mac user agent with no mobile
 * marker at all, so an iPad is detected as a Mac — there is no server-side
 * signal that separates them.
 */
export function detectPlatform(userAgent: string): VisitorPlatform {
  const ua = userAgent.toLowerCase();
  if (/android|iphone|ipad|ipod/.test(ua)) return "unknown";
  if (/windows|win32|win64/.test(ua)) return "windows";
  if (/linux|x11|cros/.test(ua)) return "linux";
  if (/macintosh|mac os x/.test(ua)) return "mac";
  return "unknown";
}

/**
 * Resolved during SSR so the first paint already shows the right call to
 * action. The worker renders every HTML response per request and sets no
 * cache-control, so varying the markup on the user agent is safe — if the
 * homepage ever gains an edge cache, it has to vary on `user-agent` too.
 */
export const getVisitorPlatform = createServerFn({ method: "GET" }).handler(
  (): VisitorPlatform => detectPlatform(getRequestHeader("user-agent") ?? ""),
);
