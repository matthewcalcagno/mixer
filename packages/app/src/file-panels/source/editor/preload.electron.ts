import { z } from "zod";
const manifestSchema = z.object({
  modules: z.array(z.string().regex(/^[\w.-]+\.js$/)).max(96),
  styles: z.array(z.string().regex(/^[\w.-]+\.css$/)).max(8),
  fonts: z
    .array(z.string().regex(/^[\w.-]+\.ttf$/))
    .max(8)
    .optional(),
});
let pending: Promise<void> | null = null;
/** Resource hints fetch and compile modules without executing editors, workers or workspace code. */
export function preloadEditorResources(): Promise<void> {
  if (pending) return pending;
  const task = fetch("/monaco/preload.json", { cache: "no-cache" }).then(async (response) => {
    if (!response.ok) throw new Error("Editor preload manifest is unavailable");
    const manifest = manifestSchema.parse(await response.json());
    for (const filename of [...manifest.modules, ...manifest.styles, ...(manifest.fonts ?? [])]) {
      if (document.head.querySelector(`link[data-mixer-editor-preload="${filename}"]`)) continue;
      const link = document.createElement("link");
      link.dataset.mixerEditorPreload = filename;
      link.href = `/monaco/${filename}`;
      link.fetchPriority = "low";
      if (filename.endsWith(".css")) {
        // These assets belong to a future editor iframe, not the current document.
        link.rel = "prefetch";
        link.as = "style";
      } else if (filename.endsWith(".ttf")) {
        link.rel = "prefetch";
        link.as = "font";
        link.type = "font/ttf";
        link.crossOrigin = "anonymous";
      } else link.rel = "modulepreload";
      document.head.appendChild(link);
    }
    return undefined;
  });
  // This optimization is optional. Actual asset failures retain the editor's visible retry path.
  pending = task.catch(() => {
    pending = null;
  });
  return pending;
}
