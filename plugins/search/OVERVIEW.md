# Search

Search appears beside Files in Explorer. It is built in and does not require
enabling external plugins or installing ripgrep on your PATH.

Type text to search the current workspace's saved files. Use the controls beside
the input for match case, whole word, and regular expressions. The details button
shows include/exclude glob filters. Commas separate patterns; brace patterns such
as `**/*.{ts,tsx}` remain intact.

Results are grouped by file, with matching text highlighted. Expand or collapse
each file, collapse all results, and click a match to open its line in the host
editor. Search uses the same Material icons, header controls, and Explorer
background as Files.

The ignore-files control is enabled by default. It honors `.gitignore`, `.ignore`,
and ripgrep's ignore rules, including in non-Git folders. Positive include filters
do not override this control. Git metadata is never searched. Symlinks are not followed.

Search is read-only. It finds text occurrences, not language-server symbol references.
It does not replace files or search unsaved buffers. Binary files and files larger
than 2 MiB are skipped. Searches return up to 1,000 matches and stop after five
seconds or their output budget. A limit message asks you to narrow the query.
Regex uses ripgrep's default engine; unsupported patterns produce an inline error.

See [Search architecture and performance](../../docs/search.md).
