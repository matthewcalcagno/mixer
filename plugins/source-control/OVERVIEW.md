# Source Control

Source Control ships with this Mixer fork. Open it after Files in the Explorer panel.
It runs without an external plugin installation or the global plugin switch.

## Review changes

- Use List or Tree view. Tree folders expand, collapse, and stage or unstage their descendant files.
- Sort the list by path, filename, or Git status from the actions menu.
- Filter filenames and paths. Group badges show repository totals, not filtered counts.
- Review Merge Changes, Staged Changes, Changes, and Untracked Changes separately.
- Click a file to open the existing editable Monaco diff. Staged comparisons are read-only.
- Stage or unstage individual files, folders, or groups. Filtered folder actions explicitly apply to matching files.
- Discard tracked working changes only after confirmation. Untracked files are never deleted.

## Commit changes

Enter a message and stage the intended files. Commit uses only the Git index.
Ctrl+Enter or Cmd+Enter in the input accepts the message. Draft messages and view
preferences are saved per workspace panel.

The dropdown retains Amend, Commit & Push, and Commit & Sync. Amend warns before
rewriting a commit. Sync pulls with fast-forward only before pushing. Resolve
Merge Changes before committing; staging a merge file explicitly marks it resolved.

Fetch, Pull, Push, Sync, stage-all-tracked, stage-all-untracked, and discard-all-tracked
are in the actions menu. Authentication uses your host's existing Git credentials.

## Limits

This is not the VS Code extension host. Repository selection, branch and stash management,
history graphs, three-way merge editing, individual line selection, publishing branches,
and force push are not provided. Binary files have no text hunk operations. The existing
Monaco diff editor runs on browser and desktop, not native mobile.

Git mutations reject stale repository revisions. Concurrent external Git operations cannot
be locked by the plugin. No remote operation runs automatically after a failed commit.

See [Source Control architecture](../../docs/source-control.md) for source references and verification.
