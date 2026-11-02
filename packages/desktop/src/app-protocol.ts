import path from "node:path";
import { pathToFileURL } from "node:url";

export function createAppProtocolHandler(
  appDistDir: string,
  fetchFile: (url: string) => Promise<Response>,
): (request: { url: string }) => Promise<Response> {
  return async (request) => {
    const { pathname, search, hash, protocol, host } = new URL(request.url);
    const decodedPath = decodeURIComponent(pathname);
    // Only the exported app entrypoint belongs to Expo Router. Nested index files
    // are real documents, including the editor warmup frame.
    if (decodedPath === "/index.html") {
      const normalizedPath = decodedPath.slice(0, -"/index.html".length) || "/";
      return Response.redirect(`${protocol}//${host}${normalizedPath}${search}${hash}`, 307);
    }
    const filePath = path.join(appDistDir, decodedPath);
    const relativePath = path.relative(appDistDir, filePath);
    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      return new Response("Not found", { status: 404 });
    }
    if (!relativePath || !path.extname(relativePath)) {
      return fetchFile(pathToFileURL(path.join(appDistDir, "index.html")).toString());
    }
    return fetchFile(pathToFileURL(filePath).toString());
  };
}
