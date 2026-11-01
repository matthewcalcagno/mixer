// Vendored from getpaseo/paseo. See THIRD_PARTY_NOTICES.md.
import data from "./material-file-icons.generated.json" with { type: "json" };

const icons: Record<string, string> = data.icons;
const fileNames: Record<string, string> = data.fileNames;
const extensions: Record<string, string> = data.fileExtensions;
const folderNames: Record<string, string> = data.folderNames;
const expandedFolderNames: Record<string, string> = data.folderNamesExpanded;
const languageExtensions: Record<string, string> = data.languageFileExtensions;
const languageFileNames: Record<string, string> = data.languageFileNames;

function normalizedPath(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

export function getRawFileIconSvg(fileName: string): string {
  const path = normalizedPath(fileName);
  const parts = path.split("/");
  const name = parts.pop() ?? "";
  const parent = parts.pop();
  const namedIcon = fileNames[`${parent}/${name}`] ?? fileNames[name];
  if (namedIcon) return icons[namedIcon];

  // VS Code prefers the longest matching compound extension.
  let dot = name.indexOf(".");
  while (dot !== -1) {
    const icon = extensions[name.slice(dot + 1)];
    if (icon) return icons[icon];
    dot = name.indexOf(".", dot + 1);
  }
  const languageNameIcon = languageFileNames[name];
  if (languageNameIcon) return icons[languageNameIcon];
  dot = name.indexOf(".");
  while (dot !== -1) {
    const icon = languageExtensions[name.slice(dot + 1)];
    if (icon) return icons[icon];
    dot = name.indexOf(".", dot + 1);
  }
  return icons[data.file];
}

export function getRawFolderIconSvg({
  folderName,
  expanded,
}: {
  folderName: string;
  expanded: boolean;
}): string {
  const name = normalizedPath(folderName).split("/").pop() ?? "";
  const associations = expanded ? expandedFolderNames : folderNames;
  const fallback = expanded ? data.folderExpanded : data.folder;
  return icons[associations[name] ?? fallback];
}
