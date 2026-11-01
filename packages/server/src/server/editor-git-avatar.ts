import type { ForgeResolution } from "../services/forge-resolver.js";

const MAX_AVATAR_BYTES = 128 * 1024;

export async function getEditorCommitAuthor(
  forge: ForgeResolution,
  cwd: string,
  sha: string,
): Promise<{ authorAvatar?: string; authorProfileUrl?: string }> {
  try {
    const author = await forge.service.getCommitAuthor?.({ cwd, sha });
    if (!author) return {};
    const avatar = new URL(author.avatarUrl);
    if (
      avatar.protocol !== "https:" ||
      avatar.username ||
      avatar.password ||
      (avatar.port && avatar.port !== "443")
    )
      return {};
    if (avatar.hostname !== "avatars.githubusercontent.com" && avatar.hostname !== forge.host)
      return {};
    const profile = author.profileUrl ? new URL(author.profileUrl) : null;
    const authorProfileUrl =
      profile?.protocol === "https:" && profile.hostname === forge.host ? profile.href : undefined;
    return { authorProfileUrl, authorAvatar: await readAvatar(avatar) };
  } catch {
    // Avatars are optional enrichment; unavailable images must not hide local history.
    return {};
  }
}

async function readAvatar(avatar: URL): Promise<string | undefined> {
  const response = await fetch(avatar, {
    redirect: "error",
    signal: AbortSignal.timeout(4000),
    headers: { Accept: "image/png,image/jpeg,image/webp" },
  });
  if (!response.ok || !response.body) return undefined;
  const type = response.headers.get("content-type")?.split(";")[0];
  if (type !== "image/png" && type !== "image/jpeg" && type !== "image/webp") {
    await response.body.cancel();
    return undefined;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_AVATAR_BYTES) return undefined;
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = Buffer.concat(chunks);
  return validImage(type, bytes) ? `data:${type};base64,${bytes.toString("base64")}` : undefined;
}

function validImage(type: string, bytes: Buffer): boolean {
  return (
    (type === "image/png" &&
      bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) ||
    (type === "image/jpeg" && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) ||
    (type === "image/webp" &&
      bytes.toString("ascii", 0, 4) === "RIFF" &&
      bytes.toString("ascii", 8, 12) === "WEBP")
  );
}
