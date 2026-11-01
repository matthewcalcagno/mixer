export interface ExplorerRefactoringProps {
  serverId: string;
  workspaceId: string | null | undefined;
  root: string;
}
export function FileExplorerRefactoringHost(_props: ExplorerRefactoringProps) {
  return null;
}
export async function renameWithReview(
  _input: ExplorerRefactoringProps & { path: string; name: string; kind: "file" | "directory" },
): Promise<{ success: true; renamedPath: string; error: null } | null | undefined> {
  return undefined;
}
