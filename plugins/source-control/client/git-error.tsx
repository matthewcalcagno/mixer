import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { Button, FormTextInput, Icon, Modal, ScrollView, copyText } from "@mixer/plugin/client/ui";
import { useMutation } from "@tanstack/react-query";
import type { PluginTheme } from "@mixer/plugin";
import { GitActionError, gitIdentityAction, actionRpc, type GitFailure } from "../shared/git.js";
import type { RpcInput } from "@mixer/plugin";

interface ErrorPresentation {
  title: string;
  description: string;
  severity: "error" | "warning" | "info";
  recovery: "sync" | "identity" | "review" | "conflicts" | "retry" | null;
}
const presentations = {
  "push-rejected": {
    title: "Push rejected",
    description:
      "The remote branch has new commits. Sync changes to pull them before pushing again. Your local commits are preserved.",
    severity: "warning",
    recovery: "sync",
  },
  authentication: {
    title: "Could not authenticate with the remote",
    description:
      "Check your Git credentials or SSH key on the workspace host, then retry. Mixer does not store your Git password or token.",
    severity: "error",
    recovery: "retry",
  },
  identity: {
    title: "Configure your Git identity",
    description:
      "Git needs your name and email address before you can commit. Your commit message and staged changes are preserved.",
    severity: "warning",
    recovery: "identity",
  },
  "local-changes": {
    title: "Local changes block this operation",
    description:
      "Review and commit or stash your changes before retrying. Mixer has not discarded your changes or stashed them automatically.",
    severity: "warning",
    recovery: "review",
  },
  hook: {
    title: "Git hook blocked the operation",
    description:
      "Review the command output and fix the reported problems, then retry. Your commit message is preserved. Mixer will not bypass the hook.",
    severity: "error",
    recovery: null,
  },
  conflict: {
    title: "Resolve conflicts to continue",
    description:
      "Open the files in Merge Changes, resolve the conflicts, and stage each resolved file before continuing.",
    severity: "warning",
    recovery: "conflicts",
  },
  "empty-cherry-pick": {
    title: "No changes left to cherry-pick",
    description:
      "The changes are already present or the conflict resolution removed them. Review the result, then use git cherry-pick --skip in the workspace terminal if you want to skip this commit.",
    severity: "info",
    recovery: null,
  },
  network: {
    title: "Could not reach the remote",
    description: "Check the workspace host's network connection and remote URL, then retry.",
    severity: "error",
    recovery: "retry",
  },
  unknown: {
    title: "Git operation failed",
    description:
      "View the command output for details. Your commit message is preserved if the commit did not succeed.",
    severity: "error",
    recovery: null,
  },
} satisfies Record<NonNullable<GitFailure["code"]>, ErrorPresentation>;

export function gitErrorPresentation(error: Error): ErrorPresentation {
  if (error instanceof GitActionError) return presentations[error.failure.code ?? "unknown"];
  return presentations.unknown;
}

type IdentityAction = Extract<RpcInput<typeof actionRpc>["action"], { kind: "configure-identity" }>;
interface GitErrorNoticeProps {
  error: Error;
  theme: PluginTheme;
  operationLabel: string;
  disabled: boolean;
  canSync: boolean;
  canRetry: boolean;
  onSync(): void;
  onRetry(): void;
  onReview(): void;
  onConflicts(): void;
  onDismiss(): void;
  onConfigure(action: IdentityAction): Promise<unknown>;
}

export function GitErrorNotice({
  error,
  theme,
  operationLabel,
  disabled,
  canSync,
  canRetry,
  onSync,
  onRetry,
  onReview,
  onConflicts,
  onDismiss,
  onConfigure,
}: GitErrorNoticeProps) {
  const [dialog, setDialog] = useState<"output" | "identity" | null>(null);
  const presentation = gitErrorPresentation(error);
  const failure: GitFailure =
    error instanceof GitActionError ? error.failure : { message: error.message, conflict: false };
  const details = [failure.command, failure.message].filter(Boolean).join("\n\n");
  const copy = useMutation({ mutationFn: () => copyText(details) });
  const { reset: resetCopy, mutate: mutateCopy } = copy;
  const openIdentity = useCallback(() => setDialog("identity"), []);
  const openOutput = useCallback(() => {
    resetCopy();
    setDialog("output");
  }, [resetCopy]);
  const closeDialog = useCallback(() => setDialog(null), []);
  const copyDetails = useCallback(() => mutateCopy(), [mutateCopy]);
  const c = theme.colors;
  let color = c.foreground;
  if (presentation.severity === "error") color = c.statusDanger;
  if (presentation.severity === "warning") color = c.statusWarning;
  const operationConflict = presentation.recovery === "conflicts" && operationLabel;
  const title = operationConflict ? `${operationLabel} has conflicts` : presentation.title;
  const styles = useMemo(() => {
    const text = {
      fontFamily: theme.typography?.fontFamily,
      fontSize: theme.typography?.chrome ?? 13,
      color: c.foreground,
    };
    return {
      text,
      title: { ...text, flex: 1, color },
      muted: { ...text, color: c.foregroundMuted },
      error: { ...text, color: c.statusDanger },
    };
  }, [theme, c, color]);
  return (
    <View style={layout.notice}>
      <View style={layout.heading}>
        <Icon
          name={presentation.severity === "error" ? "AlertCircle" : "Info"}
          size={14}
          color={color}
        />
        <Text
          accessibilityRole={presentation.severity === "info" ? undefined : "alert"}
          accessibilityLiveRegion="polite"
          style={styles.title}
        >
          {title}
        </Text>
        <Button
          size="xs"
          variant="ghost"
          icon="X"
          accessibilityLabel="Dismiss Git error"
          onPress={onDismiss}
          disabled={disabled}
        />
      </View>
      <Text style={styles.muted}>{presentation.description}</Text>
      <View style={layout.actions}>
        {presentation.recovery === "sync" && (
          <Button
            size="xs"
            variant="outline"
            disabled={disabled || !canSync}
            onPress={onSync}
            accessibilityLabel="Sync changes to resolve rejected push"
          >
            Sync Changes…
          </Button>
        )}
        {presentation.recovery === "identity" && (
          <Button size="xs" variant="outline" disabled={disabled} onPress={openIdentity}>
            Configure Git identity
          </Button>
        )}
        {presentation.recovery === "review" && (
          <Button size="xs" variant="outline" disabled={disabled} onPress={onReview}>
            Review changes
          </Button>
        )}
        {presentation.recovery === "conflicts" && (
          <Button size="xs" variant="outline" disabled={disabled} onPress={onConflicts}>
            Show conflicts
          </Button>
        )}
        {presentation.recovery === "retry" && canRetry && (
          <Button size="xs" variant="outline" disabled={disabled} onPress={onRetry}>
            Retry
          </Button>
        )}
        <Button size="xs" variant="ghost" onPress={openOutput}>
          View command output
        </Button>
      </View>
      <Modal title="Git command output" open={dialog === "output"} onOpenChange={closeDialog}>
        <Modal.Content>
          <ScrollView style={layout.output}>
            <Text selectable style={styles.text}>
              {details}
            </Text>
          </ScrollView>
          <Button
            size="sm"
            variant="outline"
            loading={copy.isPending}
            disabled={copy.isPending}
            onPress={copyDetails}
          >
            {copy.isSuccess ? "Copied" : "Copy details"}
          </Button>
          {copy.isError && (
            <Text accessibilityRole="alert" style={styles.error}>
              Could not copy the command output. Select the text to copy it manually.
            </Text>
          )}
        </Modal.Content>
      </Modal>
      <Modal title="Configure Git identity" open={dialog === "identity"} onOpenChange={closeDialog}>
        <Modal.Content>
          {dialog === "identity" && <GitIdentityForm theme={theme} onConfigure={onConfigure} />}
        </Modal.Content>
      </Modal>
    </View>
  );
}

function GitIdentityForm({
  theme,
  onConfigure,
}: Pick<GitErrorNoticeProps, "theme" | "onConfigure">) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const save = useMutation({
    mutationFn: async () => {
      await onConfigure(gitIdentityAction.parse({ kind: "configure-identity", name, email }));
    },
  });
  const styles = useMemo(() => {
    const text = { color: theme.colors.foreground, fontSize: theme.typography?.chrome ?? 13 };
    return { text, error: { ...text, color: theme.colors.statusDanger } };
  }, [theme]);
  const { mutate: saveIdentity, reset: resetSave } = save;
  const submit = useCallback(() => saveIdentity(), [saveIdentity]);
  const changeName = useCallback(
    (value: string) => {
      resetSave();
      setName(value);
    },
    [resetSave],
  );
  const changeEmail = useCallback(
    (value: string) => {
      resetSave();
      setEmail(value);
    },
    [resetSave],
  );
  const valid = gitIdentityAction.safeParse({ kind: "configure-identity", name, email }).success;
  return (
    <View style={layout.form}>
      <Text style={styles.text}>
        Save your name and email in this repository only. Global Git settings are not changed.
      </Text>
      <Text style={styles.text}>Name</Text>
      <FormTextInput
        size="sm"
        accessibilityLabel="Git author name"
        onChangeText={changeName}
        editable={!save.isPending}
      />
      <Text style={styles.text}>Email</Text>
      <FormTextInput
        size="sm"
        accessibilityLabel="Git author email"
        onChangeText={changeEmail}
        editable={!save.isPending}
        autoCapitalize="none"
      />
      <Button
        size="sm"
        disabled={!valid || save.isPending}
        loading={save.isPending}
        onPress={submit}
      >
        Save for this repository
      </Button>
      {save.isError && (
        <Text accessibilityRole="alert" style={styles.error}>
          Could not save your identity. {save.error.message}
        </Text>
      )}
      {save.isSuccess && (
        <Text accessibilityLiveRegion="polite" style={styles.text}>
          Git identity saved. Close this dialog and retry your commit.
        </Text>
      )}
    </View>
  );
}
const layout = {
  notice: { marginHorizontal: 10, marginBottom: 8, gap: 6 },
  heading: { flexDirection: "row", alignItems: "center", gap: 6 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 4 },
  output: { maxHeight: 360 },
  form: { gap: 12 },
} as const;
