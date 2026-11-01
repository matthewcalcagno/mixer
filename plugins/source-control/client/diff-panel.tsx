import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Platform, Text, View } from "react-native";
import { useRpc, type PluginWorkspacePanelProps } from "@mixer/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { documentRpc, saveDocumentRpc, gitScopeKey, type GitScope } from "../shared/git.js";
import type { DiffSelection } from "./diff-selection.js";
import { MonacoDiffEditor, type MonacoHandle } from "./web.js";

export function SourceControlDiffPanel({
  scope,
  host,
  theme,
  tab,
  selection,
  onKeepOpen,
  readOnly = false,
}: Pick<PluginWorkspacePanelProps, "host" | "theme" | "tab"> & {
  scope: GitScope;
  selection: DiffSelection;
  onKeepOpen(): void;
  readOnly?: boolean;
}) {
  const readDocument = useRpc(documentRpc);
  const save = useRpc(saveDocumentRpc);
  const queries = useQueryClient();
  const key = ["source-control", gitScopeKey(scope)];
  const [dirty, setDirty] = useState(false);
  const draft = useRef<string | null>(null);
  const baseline = useRef<string | null>(null);
  const isDirty = useRef(false);
  isDirty.current = dirty;
  const editor = useRef<MonacoHandle | null>(null);
  const contents = useQuery({
    queryKey: [...key, "document", host.id, selection],
    queryFn: () => readDocument({ ...scope, ...selection }),
    refetchInterval: 5000,
  });
  useEffect(() => {
    tab.setModified(dirty);
  }, [dirty, tab]);
  useEffect(() => {
    if (!isDirty.current && contents.data) {
      baseline.current = contents.data.modified;
      draft.current = contents.data.modified;
    }
  }, [contents.data]);
  const mutation = useMutation({
    mutationFn: ({ content, revision }: { content: string; revision: string }) => {
      if (readOnly || selection.staged) throw new Error("This comparison is read-only");
      return save({ ...scope, path: selection.path, revision, content });
    },
    onSuccess: async (result, variables) => {
      baseline.current = variables.content;
      setDirty(draft.current !== variables.content);
      editor.current?.saved(result.revision);
      await queries.invalidateQueries({ queryKey: key });
    },
    onError: () => editor.current?.saveFailed(),
  });
  const error = contents.error || mutation.error;
  const data = useMemo(
    () => (contents.data && readOnly ? { ...contents.data, editable: false } : contents.data),
    [contents.data, readOnly],
  );
  if (Platform.OS !== "web")
    return (
      <View style={{ padding: 16 }}>
        <Text style={{ color: theme.colors.foregroundMuted }}>
          The Monaco diff editor is available in Mixer desktop and web.
        </Text>
      </View>
    );
  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
      {error && (
        <Text
          accessibilityRole="alert"
          selectable
          style={{ padding: 10, color: theme.colors.statusDanger }}
        >
          {error.message}
        </Text>
      )}
      {contents.isPending && (
        <ActivityIndicator style={{ padding: 16 }} color={theme.colors.accent} />
      )}
      {data && (
        <MonacoDiffEditor
          path={selection.path}
          data={data}
          theme={theme}
          dirty={dirty}
          editorRef={editor}
          onKeepOpen={onKeepOpen}
          onChange={(content) => {
            onKeepOpen();
            draft.current = content;
            setDirty(content !== baseline.current);
          }}
          onSave={(content, revision) => {
            if (!mutation.isPending) mutation.mutate({ content, revision });
          }}
        />
      )}
    </View>
  );
}
