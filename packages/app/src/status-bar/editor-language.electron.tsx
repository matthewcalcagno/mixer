import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { View, useWindowDimensions } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Combobox, ComboboxItem, type ComboboxOption } from "@/components/ui/combobox";
import { MaterialFileIcon } from "@/components/material-file-icon";
import { useAppSettings } from "@/hooks/use-settings";
import { useToast } from "@/contexts/toast-context";
import type { Theme } from "@/styles/theme";
import type { EditorStatusEntry } from "@/file-panels/source/editor/status";
import { openLanguagePicker, type LanguagePickerRow } from "./language-picker-model";
import { StatusEntry } from "./item";

function LanguagePickerOption({
  option,
  row,
  first,
  selected,
  active,
  onPress,
}: {
  option: ComboboxOption;
  row: LanguagePickerRow | undefined;
  first: boolean;
  selected: boolean;
  active: boolean;
  onPress(): void;
}) {
  const mode = row?.kind === "language" ? row.mode : null;
  const icon = useMemo(
    () =>
      mode ? (
        <MaterialFileIcon
          fileName={mode.filenames[0] ?? `file${mode.extensions[0] ?? ""}`}
          size={16}
        />
      ) : undefined,
    [mode],
  );
  return (
    <View>
      {first && <View style={styles.separator} />}
      <ComboboxItem
        density="compact"
        elevated
        label={option.label}
        description={option.description}
        selected={selected}
        active={active}
        onPress={onPress}
        accessibilityLabel={option.label}
        testID={`language-mode-option-${mode?.id ?? option.id}`}
        leadingSlot={icon}
      />
    </View>
  );
}

function LanguageModePicker({
  entry,
  anchorRef,
  onClose,
}: {
  entry: EditorStatusEntry;
  anchorRef: React.RefObject<View | null>;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const { updateSettings } = useAppSettings();
  const toast = useToast();
  const { width, height } = useWindowDimensions();
  const measureBounds = entry.quickPickBounds;
  const [bounds, setBounds] = useState(() => measureBounds?.() ?? undefined);
  useLayoutEffect(() => {
    setBounds(measureBounds?.() ?? undefined);
  }, [measureBounds, width, height]);
  const [model] = useState(() => openLanguagePicker(entry.filename, entry.modes));
  useEffect(() => () => model.close(), [model]);
  const state = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  const rows = useMemo(() => new Map(state.rows.map((row) => [row.id, row])), [state.rows]);
  const label = useCallback(
    (row: LanguagePickerRow): string => {
      if (row.kind === "language") return row.mode.label;
      switch (row.id) {
        case "auto":
          return t("statusBar.autoDetect");
        case "association":
          return t("statusBar.configureFileAssociation", { pattern: state.pattern });
        case "back":
          return t("statusBar.backToLanguageModes");
        case "clear":
          return t("statusBar.clearFileAssociation");
      }
    },
    [t, state.pattern],
  );
  const options = useMemo<ComboboxOption[]>(
    () =>
      state.rows.map((row) => ({
        id: row.id,
        label: label(row),
        description: row.kind === "language" ? `(${row.mode.id})` : undefined,
        searchText: row.kind === "language" ? row.mode.extensions.join(" ") : undefined,
      })),
    [state.rows, label],
  );
  const openChange = useCallback(
    (open: boolean) => {
      if (!open) onClose();
    },
    [onClose],
  );
  const select = useCallback(
    (id: string) => {
      const result = model.choose(id);
      if (!result) return;
      if (result.kind === "language") {
        entry.selectLanguage(result.mode);
        onClose();
        return;
      }
      void updateSettings((previous) => {
        const fileAssociations = { ...previous.editor.fileAssociations };
        if (result.mode === null) delete fileAssociations[result.pattern];
        else fileAssociations[result.pattern] = result.mode;
        return { editor: { ...previous.editor, fileAssociations } };
      })
        .then(() => {
          if (model.isActive()) {
            entry.selectLanguage(null);
            onClose();
          }
          return undefined;
        })
        .catch((failure: unknown) => {
          if (model.isActive())
            toast.error(failure instanceof Error ? failure.message : String(failure));
        });
    },
    [model, entry, onClose, updateSettings, toast],
  );
  const renderOption = useCallback(
    ({
      option,
      selected,
      active,
      onPress,
    }: {
      option: ComboboxOption;
      selected: boolean;
      active: boolean;
      onPress(): void;
    }) => {
      const first = state.rows.find((candidate) => candidate.kind === "language");
      return (
        <LanguagePickerOption
          option={option}
          row={rows.get(option.id)}
          first={first?.id === option.id}
          selected={selected}
          active={active}
          onPress={onPress}
        />
      );
    },
    [rows, state.rows],
  );
  return (
    <Combobox
      key={state.phase}
      anchorRef={anchorRef}
      open
      onOpenChange={openChange}
      options={options}
      value={`language:${entry.id}`}
      onSelect={select}
      renderOption={renderOption}
      searchPlaceholder={
        state.phase === "association"
          ? t("statusBar.selectFileAssociation", { pattern: state.pattern })
          : t("statusBar.selectLanguageMode")
      }
      desktopPresentation="quick-pick"
      desktopQuickPickBounds={bounds}
      keepOpenOnSelect
    />
  );
}

function LanguageStatus({ entry, theme }: { entry: EditorStatusEntry; theme: Theme }) {
  const { t } = useTranslation();
  const anchorRef = useRef<View>(null);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => {
    setOpen(false);
    entry.focus();
  }, [entry]);
  const show = useCallback(() => setOpen(true), []);
  const language = entry.modes.find((mode) => mode.id === entry.id);
  return (
    <View ref={anchorRef} collapsable={false}>
      <StatusEntry
        label={language?.label ?? entry.id}
        accessibilityLabel={language?.label ?? entry.id}
        tooltip={t("statusBar.selectLanguageMode")}
        color={theme.colors.foregroundMuted}
        onPress={show}
        testID="status-bar-language-mode"
      />
      {open && <LanguageModePicker entry={entry} anchorRef={anchorRef} onClose={close} />}
    </View>
  );
}
export const EditorLanguageStatus = withUnistyles(LanguageStatus, (theme) => ({ theme }));
const styles = StyleSheet.create((theme) => ({
  separator: {
    height: 1,
    backgroundColor: theme.colors.border,
    marginHorizontal: theme.spacing[2],
    marginVertical: theme.spacing[1],
  },
}));
