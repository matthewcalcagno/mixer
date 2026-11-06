import type { ComponentProps } from "react";
import { useRef, useMemo, useState, type ReactNode, useCallback } from "react";
import { Modal } from "@mixer/plugin/client/ui";
import type { PluginTheme } from "@mixer/plugin";
import type { Environment, Pair } from "../shared/contracts.js";
import { folderPath } from "./collection-model.js";
import type { Collection } from "./model.js";
import { importCollection } from "./import-export.js";
import { Action, Field, PairEditor } from "./controls.js";
import { themeStyle } from "./styles.js";
export function Dialog({
  title,
  close,
  theme,
  children,
}: {
  title: string;
  close: () => void;
  theme: PluginTheme;
  children: ReactNode;
}) {
  const style = useMemo(
    () => ({
      ...themeStyle(theme),
      height: "auto",
      overflow: "visible",
      background: "transparent",
    }),
    [theme],
  );
  const onOpenChangeModal = useCallback<NonNullable<ComponentProps<typeof Modal>["onOpenChange"]>>(
    (open) => {
      if (!open) close();
    },
    [close],
  );
  return (
    <Modal title={title} open onOpenChange={onOpenChangeModal}>
      <Modal.Content>
        <div className="ac-root ac-dialog" style={style}>
          {children}
        </div>
      </Modal.Content>
    </Modal>
  );
}
export function ImportDialog({
  close,
  theme,
  onImport,
}: {
  close: () => void;
  theme: PluginTheme;
  onImport: (collection: Collection) => void;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const chooseImportFile = useCallback<NonNullable<ComponentProps<typeof Action>["onClick"]>>(
    () => input.current?.click(),
    [input],
  );
  const onChangeImportData = useCallback<NonNullable<ComponentProps<"textarea">["onChange"]>>(
    (event) => setText(event.target.value),
    [setText],
  );
  const readImportFile = useCallback<NonNullable<ComponentProps<"input">["onChange"]>>(
    (event) => {
      const file = event.target.files?.[0];
      if (!file) return;
      if (file.size > 5_000_000) {
        setError("Import files must be smaller than 5 MB.");
        return;
      }
      void file
        .text()
        .then(setText)
        .catch(() => setError("Unable to read import file."));
    },
    [setError, setText],
  );
  const submit = useCallback(() => {
    try {
      onImport(importCollection(text));
      close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to import collection.");
    }
  }, [onImport, text, close, setError]);
  return (
    <Dialog title="Import requests" theme={theme} close={close}>
      <p className="ac-muted">
        Paste cURL, a Postman v2 collection, or an exported Mixer collection. HTTP requests, bodies,
        and auth are imported. Collection scripts are excluded.
      </p>
      <input
        className="ac-hidden"
        type="file"
        ref={input}
        accept=".json,.txt"
        onChange={readImportFile}
      />
      <textarea
        className="ac-code-editor"
        aria-label="Import data"
        placeholder="curl https://api.example.com/health"
        value={text}
        onChange={onChangeImportData}
      />
      {error && (
        <div role="alert" className="ac-notice" data-error>
          {error}
        </div>
      )}
      <div className="ac-dialog-actions">
        <Action size="sm" icon="Upload" onClick={chooseImportFile}>
          Choose file
        </Action>
        <Action size="sm" onClick={close}>
          Cancel
        </Action>
        <Action size="sm" primary onClick={submit} disabled={!text.trim()}>
          Import
        </Action>
      </div>
    </Dialog>
  );
}
export function SaveDialog({
  theme,
  close,
  collections,
  initialCollectionId,
  initialFolderId,
  requestName,
  onSave,
}: {
  theme: PluginTheme;
  close: () => void;
  collections: Collection[];
  initialCollectionId?: string;
  initialFolderId?: string;
  requestName: string;
  onSave: (name: string, collectionId: string, folderId?: string) => void;
}) {
  const [name, setName] = useState(requestName);
  const [collectionId, setCollectionId] = useState(initialCollectionId ?? collections[0]?.id ?? "");
  const [folderId, setFolderId] = useState(initialFolderId ?? "");
  const changeFolder = useCallback(
    (event: React.ChangeEvent<HTMLSelectElement>) => setFolderId(event.target.value),
    [],
  );
  const saveRequest = useCallback<NonNullable<ComponentProps<typeof Action>["onClick"]>>(() => {
    onSave(name.trim(), collectionId, folderId || undefined);
    close();
  }, [onSave, name, collectionId, folderId, close]);
  const onChangeSaveToCollection = useCallback<NonNullable<ComponentProps<"select">["onChange"]>>(
    (event) => {
      setCollectionId(event.target.value);
      setFolderId("");
    },
    [setCollectionId],
  );
  const onChangeSavedRequestName = useCallback<NonNullable<ComponentProps<"input">["onChange"]>>(
    (event) => setName(event.target.value),
    [setName],
  );
  return (
    <Dialog title="Save request" theme={theme} close={close}>
      <Field label="Request name">
        <input
          autoFocus
          aria-label="Saved request name"
          value={name}
          onChange={onChangeSavedRequestName}
        />
      </Field>
      <Field label="Collection">
        <select
          aria-label="Save to collection"
          value={collectionId}
          onChange={onChangeSaveToCollection}
        >
          {collections.map((collection) => (
            <option key={collection.id} value={collection.id}>
              {collection.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Folder">
        <select aria-label="Save to folder" value={folderId} onChange={changeFolder}>
          <option value="">Collection root</option>
          {collections
            .find((collection) => collection.id === collectionId)
            ?.folders?.map((folder) => (
              <option key={folder.id} value={folder.id}>
                {folderPath(
                  collections.find((collection) => collection.id === collectionId)!,
                  folder.id,
                )}
              </option>
            ))}
        </select>
      </Field>
      {!collections.length && (
        <p className="ac-muted">Create a collection in the right panel before saving.</p>
      )}
      <div className="ac-dialog-actions">
        <Action size="sm" onClick={close}>
          Cancel
        </Action>
        <Action size="sm" primary disabled={!name.trim() || !collectionId} onClick={saveRequest}>
          Save request
        </Action>
      </div>
    </Dialog>
  );
}
export function EnvironmentDialog({
  theme,
  close,
  environment,
  globals,
  scopeName,
  onSave,
}: {
  theme: PluginTheme;
  close: () => void;
  environment?: Environment;
  globals?: Pair[];
  scopeName?: string;
  onSave: (value: Environment) => void;
}) {
  const [name, setName] = useState(environment?.name ?? "Global variables");
  const [variables, setVariables] = useState(environment?.variables ?? globals ?? []);
  const saveVariables = useCallback<NonNullable<ComponentProps<typeof Action>["onClick"]>>(() => {
    onSave({
      id: environment?.id ?? crypto.randomUUID(),
      name: name.trim(),
      variables,
    });
    close();
  }, [onSave, environment, name, variables, close]);
  const onChangeEnvironmentName = useCallback<NonNullable<ComponentProps<"input">["onChange"]>>(
    (event) => setName(event.target.value),
    [setName],
  );
  const title = scopeName ? `${scopeName} variables` : undefined;
  return (
    <Dialog
      title={title ?? (globals ? "Global variables" : "Environment")}
      theme={theme}
      close={close}
    >
      {!globals && !scopeName && (
        <Field label="Environment name">
          <input
            aria-label="Environment name"
            autoFocus
            value={name}
            onChange={onChangeEnvironmentName}
          />
        </Field>
      )}
      <PairEditor name="variable" pairs={variables} onChange={setVariables} />
      <p className="ac-muted">Values, including credentials, are saved on this device.</p>
      <p className="ac-muted">
        Environment variables override collection variables, then globals. Disabled rows are
        excluded.
      </p>
      <div className="ac-dialog-actions">
        <Action size="sm" onClick={close}>
          Cancel
        </Action>
        <Action size="sm" primary disabled={!name.trim()} onClick={saveVariables}>
          Save variables
        </Action>
      </div>
    </Dialog>
  );
}

export function NameDialog({
  theme,
  title,
  label,
  initialName = "",
  confirmLabel = "Create",
  close,
  submit,
}: {
  theme: PluginTheme;
  title: string;
  label: string;
  initialName?: string;
  confirmLabel?: string;
  close(): void;
  submit(name: string): void;
}) {
  const form = useRef<HTMLFormElement>(null);
  const submitForm = useCallback(() => form.current?.requestSubmit(), []);
  const [name, setName] = useState(initialName);
  const change = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => setName(event.target.value),
    [],
  );
  const select = useCallback(
    (event: React.FocusEvent<HTMLInputElement>) => event.target.select(),
    [],
  );
  const save = useCallback(
    (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (name.trim()) submit(name.trim());
    },
    [name, submit],
  );
  return (
    <Dialog title={title} theme={theme} close={close}>
      <form ref={form} className="ac-name-form" onSubmit={save}>
        <Field label={label}>
          <input
            autoFocus
            aria-label={label}
            value={name}
            onChange={change}
            onFocus={select}
            maxLength={128}
            placeholder={label}
          />
        </Field>
        <div className="ac-dialog-actions">
          <Action onClick={close}>Cancel</Action>
          <button type="submit" className="ac-hidden" tabIndex={-1} aria-hidden="true" />{" "}
          <Action primary disabled={!name.trim()} onClick={submitForm}>
            {confirmLabel}
          </Action>
        </div>
      </form>
    </Dialog>
  );
}
