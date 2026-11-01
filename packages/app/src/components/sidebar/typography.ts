import type { Theme } from "@/styles/theme";

export function sidebarTypography({ fontSize }: Pick<Theme, "fontSize">) {
  const primary = { fontSize: fontSize.chrome, lineHeight: Math.round(fontSize.chrome * 1.5) };
  const secondary = { fontSize: fontSize.sm, lineHeight: Math.round((fontSize.sm * 4) / 3) };
  const workspaceTitle = {
    fontSize: { xs: primary.fontSize, md: fontSize.sm },
    lineHeight: { xs: primary.lineHeight, md: Math.round(fontSize.sm * 1.5) },
  };
  const workspaceMetadata = {
    fontSize: { xs: secondary.fontSize, md: fontSize.xs },
    lineHeight: { xs: secondary.lineHeight, md: Math.round((fontSize.xs * 4) / 3) },
  };
  return {
    primary,
    projectTitle: { ...primary, fontSize: fontSize.base },
    secondary,
    workspaceTitle,
    workspaceMetadata,
    trailing: { ...workspaceMetadata, lineHeight: workspaceTitle.lineHeight },
  };
}
