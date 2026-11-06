import { lazy, Suspense } from "react";
import type { CodeEditorProps } from "@mixer/plugin/client/ui";

const Editor = lazy(() => import("./code-editor-view"));
/** Load the editor engine only when a plugin actually opens a code buffer. */
export function CodeEditor(props: CodeEditorProps) {
  return (
    <Suspense fallback={null}>
      <Editor {...props} />
    </Suspense>
  );
}
