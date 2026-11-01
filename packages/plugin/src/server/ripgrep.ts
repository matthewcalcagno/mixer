/** The daemon ships its own search binary; workspace code never selects an executable. */
export async function resolveRipgrepPath(): Promise<string> {
  const { rgPath } = await import("@vscode/ripgrep");
  return rgPath.replace(/([\\/])app\.asar([\\/])/, "$1app.asar.unpacked$2");
}
