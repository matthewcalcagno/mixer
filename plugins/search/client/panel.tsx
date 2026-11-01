import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { Text, View } from "react-native";
import { FlatList, PaneHeader, PaneHeaderAction, TextInput } from "@mixer/plugin/client/ui";
import type { PluginWorkspacePanelProps, PluginProjectPanelProps } from "@mixer/plugin/client";
import type { SearchOptions, SearchScope } from "../shared/search.js";
import { optionsSchema } from "../shared/search.js";
import { resultRows, statusMessage, limitMessage, type SearchRow } from "./model.js";
import { createStyles } from "./styles.js";
import { ResultRow } from "./result-row.js";
import { useSearch } from "./use-search.js";
import { z } from "zod";

const defaults: SearchOptions = {
  query: "",
  caseSensitive: false,
  wholeWord: false,
  regex: false,
  includes: "",
  excludes: "",
  respectIgnore: true,
};
const draftSchema = optionsSchema.extend({ query: z.string().max(1000) });
type ToggleKey = "caseSensitive" | "wholeWord" | "regex";
interface ToggleProps {
  field: ToggleKey;
  options: SearchOptions;
  setOptions: Dispatch<SetStateAction<SearchOptions>>;
}
const toggleLabels = {
  caseSensitive: ["CaseSensitive", "Match case"],
  wholeWord: ["WholeWord", "Match whole word"],
  regex: ["Regex", "Use regular expression"],
};
function SearchToggle({ field, options, setOptions }: ToggleProps) {
  const toggle = useCallback(
    () => setOptions((previous) => ({ ...previous, [field]: !previous[field] })),
    [field, setOptions],
  );
  const [icon, label] = toggleLabels[field];
  return <PaneHeaderAction icon={icon} label={label} selected={options[field]} onPress={toggle} />;
}
function rowKey(row: SearchRow): string {
  if (row.kind === "file") return `file:${row.path}`;
  return `${row.path}:${row.match.line}:${row.match.column}`;
}
function rowLayout(_data: ArrayLike<SearchRow> | null | undefined, index: number) {
  return { length: 24, offset: index * 24, index };
}

export function SearchPanel({ workspaceId, theme, tab, navigation }: PluginWorkspacePanelProps) {
  const scope = useMemo(() => ({ workspaceId }), [workspaceId]);
  const openFile = useCallback(
    (path: string, lineStart: number) => {
      if (!navigation?.openFile)
        throw new Error("Update Mixer to open search results in the editor.");
      navigation.openFile({ workspaceId, path, lineStart });
    },
    [navigation, workspaceId],
  );
  return <SearchBody scope={scope} theme={theme} tab={tab} openFile={openFile} />;
}
export function ProjectSearchPanel({ projectId, theme, tab, openFile }: PluginProjectPanelProps) {
  const scope = useMemo(() => ({ projectId }), [projectId]);
  return <SearchBody scope={scope} theme={theme} tab={tab} openFile={openFile} />;
}
function SearchBody({
  scope,
  theme,
  tab,
  openFile,
}: Pick<PluginWorkspacePanelProps, "theme" | "tab"> & {
  scope: SearchScope;
  openFile(path: string, lineStart: number): void;
}) {
  const [options, setOptions] = useState<SearchOptions>(() => {
    const saved = draftSchema.safeParse(tab.state);
    return saved.success ? saved.data : defaults;
  });
  const persist = useRef(tab.setState);
  persist.current = tab.setState;
  useEffect(() => {
    persist.current(options);
  }, [options]);
  const { state, stop, refresh } = useSearch(scope, options);
  const [details, setDetails] = useState(Boolean(options.includes || options.excludes));
  const [focusedField, setFocusedField] = useState<"query" | "includes" | "excludes" | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [openError, setOpenError] = useState<string | null>(null);
  const styles = useMemo(() => createStyles(theme), [theme]);
  const queryFrameStyle = useMemo(
    () => [styles.queryFrame, focusedField === "query" && styles.focusedFrame],
    [styles, focusedField],
  );
  const includesFrameStyle = useMemo(
    () => [styles.filterFrame, focusedField === "includes" && styles.focusedFrame],
    [styles, focusedField],
  );
  const excludesFrameStyle = useMemo(
    () => [styles.filterFrame, focusedField === "excludes" && styles.focusedFrame],
    [styles, focusedField],
  );
  const focusQuery = useCallback(() => setFocusedField("query"), []);
  const focusIncludes = useCallback(() => setFocusedField("includes"), []);
  const focusExcludes = useCallback(() => setFocusedField("excludes"), []);
  const blurField = useCallback(() => setFocusedField(null), []);
  const rows = useMemo(() => resultRows(state, collapsed), [state, collapsed]);
  const updateQuery = useCallback(
    (query: string) => setOptions((previous) => ({ ...previous, query })),
    [],
  );
  const updateIncludes = useCallback(
    (includes: string) => setOptions((previous) => ({ ...previous, includes })),
    [],
  );
  const updateExcludes = useCallback(
    (excludes: string) => setOptions((previous) => ({ ...previous, excludes })),
    [],
  );
  const toggleDetails = useCallback(() => setDetails((value) => !value), []);
  const toggleIgnore = useCallback(
    () => setOptions((previous) => ({ ...previous, respectIgnore: !previous.respectIgnore })),
    [],
  );
  const clear = useCallback(() => updateQuery(""), [updateQuery]);
  const collapseAll = useCallback(() => {
    if (state.kind === "complete")
      setCollapsed(new Set(state.result.files.map((file) => file.path)));
  }, [state]);
  const toggleFile = useCallback(
    (path: string) =>
      setCollapsed((previous) => {
        const next = new Set(previous);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        return next;
      }),
    [],
  );
  const open = useCallback(
    (path: string, lineStart: number) => {
      setOpenError(null);
      try {
        openFile(path, lineStart);
      } catch (error) {
        setOpenError(error instanceof Error ? error.message : "Unable to open search result");
      }
    },
    [openFile],
  );
  const renderItem = useCallback(
    ({ item }: { item: SearchRow }) => (
      <ResultRow
        row={item}
        styles={styles}
        theme={theme}
        collapsed={collapsed.has(item.path)}
        onToggle={toggleFile}
        onOpen={open}
      />
    ),
    [styles, theme, collapsed, toggleFile, open],
  );
  const message = statusMessage(state);
  const stateStyle = state.kind === "error" ? styles.error : styles.summary;
  return (
    <View style={styles.panel} testID="workspace-search-panel">
      <PaneHeader title="Search" testID="search-pane-header">
        <PaneHeaderAction
          icon="RotateCw"
          label="Refresh search"
          onPress={refresh}
          disabled={!options.query || state.kind === "pending"}
        />
        <PaneHeaderAction
          icon="ListCollapse"
          label="Collapse all search results"
          onPress={collapseAll}
          disabled={!rows.length}
        />
        <PaneHeaderAction
          icon={state.kind === "pending" ? "Square" : "X"}
          label={state.kind === "pending" ? "Stop search" : "Clear search"}
          onPress={state.kind === "pending" ? stop : clear}
        />
        <PaneHeaderAction
          icon="Ellipsis"
          label="Toggle search details"
          onPress={toggleDetails}
          selected={details}
        />
      </PaneHeader>
      <View style={styles.inputs}>
        <View testID="workspace-search-query-frame" style={queryFrameStyle}>
          <TextInput
            accessibilityLabel="Search workspace text"
            testID="workspace-search-input"
            placeholder="Search"
            placeholderTextColor={theme.colors.foregroundMuted}
            value={options.query}
            onChangeText={updateQuery}
            onFocus={focusQuery}
            onBlur={blurField}
            onSubmitEditing={refresh}
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={1000}
            style={styles.query}
            returnKeyType="search"
          />
          <SearchToggle field="caseSensitive" options={options} setOptions={setOptions} />
          <SearchToggle field="wholeWord" options={options} setOptions={setOptions} />
          <SearchToggle field="regex" options={options} setOptions={setOptions} />
        </View>
        {details && (
          <>
            <Text style={styles.label}>files to include</Text>
            <View style={includesFrameStyle}>
              <TextInput
                accessibilityLabel="Files to include"
                placeholder="e.g. src/**, *.ts"
                placeholderTextColor={theme.colors.foregroundMuted}
                value={options.includes}
                onChangeText={updateIncludes}
                onFocus={focusIncludes}
                onBlur={blurField}
                style={styles.filter}
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>
            <Text style={styles.label}>files to exclude</Text>
            <View style={excludesFrameStyle}>
              <TextInput
                accessibilityLabel="Files to exclude"
                placeholder="e.g. **/dist/**"
                placeholderTextColor={theme.colors.foregroundMuted}
                value={options.excludes}
                onChangeText={updateExcludes}
                onFocus={focusExcludes}
                onBlur={blurField}
                style={styles.filter}
                autoCapitalize="none"
                autoCorrect={false}
              />
              <PaneHeaderAction
                icon="ListFilter"
                label="Use ignore files"
                selected={options.respectIgnore}
                onPress={toggleIgnore}
              />
            </View>
          </>
        )}
      </View>
      <Text
        style={stateStyle}
        accessibilityRole={state.kind === "error" ? "alert" : undefined}
        testID="search-status"
      >
        {message}
      </Text>
      {openError && (
        <Text style={styles.error} accessibilityRole="alert">
          {openError}
        </Text>
      )}
      {state.kind === "complete" && state.result.limited && (
        <Text style={styles.footer}>{limitMessage(state.result.limitReason)}</Text>
      )}
      <FlatList
        data={rows}
        style={styles.list}
        renderItem={renderItem}
        keyExtractor={rowKey}
        getItemLayout={rowLayout}
        initialNumToRender={40}
        maxToRenderPerBatch={40}
        windowSize={5}
        keyboardShouldPersistTaps="handled"
        testID="search-results"
      />
    </View>
  );
}
