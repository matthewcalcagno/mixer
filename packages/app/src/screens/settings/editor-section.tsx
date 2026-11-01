import { Fragment, useState, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from "@/components/settings";
import { Switch } from "@/components/ui/switch";
import { SettingsRow } from "@/components/settings";
import { useAppSettings, sanitizeFontFamily } from "@/hooks/use-settings";
import { hasMonacoEditor } from "@/file-panels/source/editor/capabilities";
import {
  DEFAULT_EDITOR_PREFERENCES,
  editorPreferencesSchema,
  type EditorPreferences,
} from "@/file-panels/source/editor/preferences";
type BooleanKey = {
  [K in keyof EditorPreferences]: EditorPreferences[K] extends boolean ? K : never;
}[keyof EditorPreferences];
type NumberKey = "fontSize" | "lineHeight" | "letterSpacing" | "tabSize";
type SelectKey =
  | "wordWrap"
  | "lineNumbers"
  | "renderWhitespace"
  | "renderLineHighlight"
  | "cursorStyle"
  | "cursorBlinking";
type EditorSetting =
  | {
      kind: "switch";
      key: BooleanKey;
      desktop?: boolean;
    }
  | {
      kind: "number";
      key: NumberKey;
    }
  | {
      kind: "select";
      key: SelectKey;
      values: readonly string[];
      desktop?: boolean;
    };
const GROUPS = [
  {
    key: "font",
    fields: [
      { kind: "number", key: "fontSize" },
      { kind: "number", key: "lineHeight" },
      { kind: "number", key: "letterSpacing" },
      { kind: "switch", key: "fontLigatures" },
    ],
  },
  {
    key: "layout",
    fields: [
      { kind: "select", key: "wordWrap", values: ["default", "off", "on"] },
      { kind: "select", key: "lineNumbers", values: ["on", "off", "relative"] },
      { kind: "select", key: "renderWhitespace", values: ["none", "trailing", "all"] },
      { kind: "select", key: "renderLineHighlight", values: ["none", "gutter", "line", "all"] },
      { kind: "switch", key: "folding" },
      { kind: "switch", key: "minimap", desktop: true },
      { kind: "switch", key: "stickyScroll", desktop: true },
    ],
  },
  {
    key: "indentation",
    fields: [
      { kind: "number", key: "tabSize" },
      { kind: "switch", key: "insertSpaces" },
      { kind: "switch", key: "detectIndentation", desktop: true },
      { kind: "switch", key: "indentationGuides", desktop: true },
      { kind: "switch", key: "rainbowBrackets", desktop: true },
      { kind: "switch", key: "bracketPairGuides", desktop: true },
      { kind: "switch", key: "matchBrackets" },
    ],
  },
  {
    key: "cursor",
    fields: [
      {
        kind: "select",
        key: "cursorStyle",
        values: ["line", "block", "underline", "line-thin", "block-outline", "underline-thin"],
        desktop: true,
      },
      {
        kind: "select",
        key: "cursorBlinking",
        values: ["blink", "smooth", "phase", "expand", "solid"],
        desktop: true,
      },
      { kind: "switch", key: "smoothCaret", desktop: true },
      { kind: "switch", key: "smoothScrolling", desktop: true },
      { kind: "switch", key: "scrollBeyondLastLine" },
      { kind: "switch", key: "mouseWheelZoom", desktop: true },
    ],
  },
  {
    key: "typing",
    fields: [
      { kind: "switch", key: "autoClosingBrackets" },
      { kind: "switch", key: "autoClosingQuotes", desktop: true },
      { kind: "switch", key: "quickSuggestions", desktop: true },
      { kind: "switch", key: "suggestOnTriggerCharacters", desktop: true },
      { kind: "switch", key: "parameterHints", desktop: true },
      { kind: "switch", key: "selectionHighlight", desktop: true },
    ],
  },
  {
    key: "git",
    fields: [
      { kind: "switch", key: "gitBlame", desktop: true },
      { kind: "switch", key: "gitCodeLens", desktop: true },
      { kind: "switch", key: "gitHover", desktop: true },
    ],
  },
] satisfies {
  key: string;
  fields: EditorSetting[];
}[];
function EditorSettingRow({ field }: { field: EditorSetting }) {
  const { t } = useTranslation();
  const { settings, updateSettings } = useAppSettings();
  const [error, setError] = useState<string>();
  const label = t(`settings.editor.options.${field.key}`);
  const setPreference = useCallback(
    <K extends keyof EditorPreferences>(key: K, value: EditorPreferences[K]) => {
      void updateSettings((current) => ({ editor: { ...current.editor, [key]: value } }));
    },
    [updateSettings],
  );
  const changeSwitch = useCallback(
    (value: boolean) => {
      if (field.kind === "switch") setPreference(field.key, value);
    },
    [field, setPreference],
  );
  const changeSelect = useCallback(
    (value: string) => {
      if (field.kind === "select")
        setPreference(field.key, editorPreferencesSchema.shape[field.key].parse(value));
    },
    [field, setPreference],
  );
  const changeNumber = useCallback(
    (text: string) => {
      if (field.kind !== "number") return;
      const input = text.trim() === "" && field.key === "fontSize" ? null : Number(text);
      const result = editorPreferencesSchema.shape[field.key]
        .removeCatch()
        .safeParse(text.trim() === "" && field.key !== "fontSize" ? undefined : input);
      if (!result.success) {
        setError(result.error.issues[0]?.message);
        return;
      }
      setError(undefined);
      setPreference(field.key, result.data);
    },
    [field, setPreference],
  );
  const options = useMemo(
    () =>
      field.kind === "select"
        ? field.values.map((value) => ({ value, label: t(`settings.editor.values.${value}`) }))
        : [],
    [field, t],
  );
  switch (field.kind) {
    case "switch":
      return (
        <SettingsSwitch
          label={label}
          value={settings.editor[field.key]}
          onValueChange={changeSwitch}
        />
      );
    case "select":
      return (
        <SettingsSelect
          label={label}
          value={settings.editor[field.key]}
          options={options}
          onValueChange={changeSelect}
        />
      );
    case "number":
      return (
        <SettingsInput
          label={label}
          initialValue={String(settings.editor[field.key] ?? "")}
          placeholder={
            field.key === "fontSize" ? t("settings.editor.inheritAppearance") : undefined
          }
          error={error}
          onChangeText={changeNumber}
        />
      );
  }
}
export function EditorSection() {
  const { isLoading } = useAppSettings();
  return isLoading ? null : <EditorSettingsControls />;
}
function EditorSettingsControls() {
  const { t } = useTranslation();
  const { settings, updateSettings } = useAppSettings();
  const [generation, setGeneration] = useState(0);
  const desktop = hasMonacoEditor;
  const visibleGroups = useMemo(
    () =>
      GROUPS.map((group) => ({
        key: group.key,
        fields: group.fields.filter((field) => !("desktop" in field && field.desktop) || desktop),
      })).filter((group) => group.fields.length > 0),
    [desktop],
  );
  const changeVim = useCallback(
    (vimKeybindings: boolean) => void updateSettings({ vimKeybindings }),
    [updateSettings],
  );
  const changeFont = useCallback(
    (text: string) => {
      const fontFamily = sanitizeFontFamily(text);
      if (fontFamily !== null)
        void updateSettings((current) => ({ editor: { ...current.editor, fontFamily } }));
    },
    [updateSettings],
  );
  const reset = useCallback(() => {
    void updateSettings({ editor: DEFAULT_EDITOR_PREFERENCES, vimKeybindings: false });
    setGeneration((value) => value + 1);
  }, [updateSettings]);
  return (
    <Fragment key={generation}>
      <SettingsSection title={t("settings.editor.keyboard")}>
        <SettingsCard>
          <SettingsRow label={t("settings.editor.vimKeybindings")}>
            <Switch
              value={settings.vimKeybindings}
              onValueChange={changeVim}
              accessibilityLabel={t("settings.editor.vimKeybindings")}
              testID="vim-keybindings-toggle"
            />
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>
      {visibleGroups.map((group) => (
        <SettingsSection key={group.key} title={t(`settings.editor.groups.${group.key}`)}>
          <SettingsCard>
            {group.key === "font" ? (
              <SettingsInput
                label={t("settings.editor.fontFamily")}
                initialValue={settings.editor.fontFamily}
                placeholder={t("settings.editor.inheritAppearance")}
                onChangeText={changeFont}
              />
            ) : null}
            {group.fields.map((field) => (
              <EditorSettingRow key={field.key} field={field} />
            ))}
          </SettingsCard>
        </SettingsSection>
      ))}
      <SettingsSection title={t("settings.editor.defaults")}>
        <SettingsCard>
          <SettingsAction
            label={t("settings.editor.resetLabel")}
            actionLabel={t("settings.editor.reset")}
            onPress={reset}
          />
        </SettingsCard>
      </SettingsSection>
    </Fragment>
  );
}
