#!/usr/bin/env python3
"""Remove the workspace-specific native adapter now owned by the shared menu surface."""
from pathlib import Path
import re

path = Path(__file__).resolve().parent.parent / "packages/app/src/components/sidebar/sidebar-workspace-menu.tsx"
text = path.read_text()
start = text.index("export function SidebarWorkspaceContextMenu(")
prefix, component = text[:start], text[start:]
component, count = re.subn(
    r"  const isElectron = getIsElectron\(\);.*?(?=  return \()",
    "  const pages = useWorkspaceLabelMenuPages(workspaceTarget);\n",
    component, count=1, flags=re.DOTALL,
)
if count != 1:
    raise SystemExit("The workspace adapter is already removed or has changed; no files written.")
component = re.sub(r"^\s*enabledOnWeb=\{!isElectron[^\n]*\}\n", "\n", component, flags=re.MULTILINE)
component = re.sub(r"^\s*onContextMenu=\{isElectron[^\n]*\}\n", "\n", component, flags=re.MULTILINE)
component = component.replace("{!isElectron && (", "").replace("</ContextMenuContent>\n      )}", "</ContextMenuContent>")
path.write_text(prefix + component)
