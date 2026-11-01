import * as monaco from "monaco-editor";
import { z } from "zod";
import {
  editorGitBlameSchema,
  editorGitCommitDetailsSchema,
  gitObjectIdSchema,
  type EditorGitBlame,
  type EditorGitCommit,
  type EditorGitCommitDetails,
} from "@mixer/protocol/editor-git";
import type { EditorCommand, EditorConfiguration, EditorEvent } from "./messages";
import {
  COPY_GIT_COMMIT,
  REFRESH_GIT,
  escapeGitMarkdown,
  gitFileAuthorship,
  gitHoverMarkdown,
  gitInlineText,
  isUncommitted,
  relativeCommitTime,
} from "./git-presentation";

const INSPECT_COMMIT = "mixer.git.inspectCommit";
interface PendingGitRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}
interface GitAnnotationsOptions {
  editor: monaco.editor.IStandaloneCodeEditor;
  model: monaco.editor.ITextModel;
  configuration: EditorConfiguration;
  emit(event: EditorEvent): void;
  prepareDiffSyntax(): Promise<void>;
}

export class GitAnnotations implements monaco.IDisposable {
  private readonly decorations;
  private readonly lensesChanged = new monaco.Emitter<monaco.languages.CodeLensProvider>();
  private readonly disposables: monaco.IDisposable[] = [];
  private readonly provider: monaco.languages.CodeLensProvider;
  private readonly pending = new Map<string, PendingGitRequest>();
  private readonly details = new Map<string, EditorGitCommitDetails>();
  private readonly detailRequests = new Map<string, Promise<EditorGitCommitDetails>>();
  private readonly detailErrors = new Map<string, string>();
  private readonly lines = new Map<
    number,
    Extract<EditorGitBlame, { kind: "ready" }>["lines"][number]
  >();
  private readonly commits = new Map<string, EditorGitCommit>();
  private refreshing: { version: number; task: Promise<void> } | null = null;
  private blame: EditorGitBlame | null = null;
  private blameVersion = -1;
  private generation = 0;
  private disposed = false;
  private renderedLine = 0;
  private renderedSelectionCount = 0;
  private configuration: EditorConfiguration;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private detailsTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: GitAnnotationsOptions) {
    this.configuration = options.configuration;
    const { editor, model } = options;
    this.decorations = editor.createDecorationsCollection();
    const style = document.createElement("style");
    style.textContent = `
      .mixer-git-inline{color:var(--mixer-git-foreground);opacity:.4;font-style:normal;}
      .monaco-hover:has(a[data-href*="mixer.git.copyCommit"]){
        border-radius:8px!important;border:1px solid var(--mixer-git-border)!important;
        background:var(--mixer-git-background)!important;box-shadow:0 6px 24px #00000028;
      }
      .monaco-hover:has(a[data-href*="mixer.git.copyCommit"]) .markdown-hover{
        padding:6px 8px!important;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
        font-size:13px;font-weight:400;line-height:1.4;min-width:min(360px,calc(100vw - 64px));
      }
      .monaco-hover:has(a[data-href*="mixer.git.copyCommit"]) .markdown-hover > .hover-contents{padding:0!important;}
      .monaco-hover:has(a[data-href*="mixer.git.copyCommit"]) .markdown-hover p{margin:0 0 6px;}
      .monaco-hover:has(a[data-href*="mixer.git.copyCommit"]) .markdown-hover p:last-child{margin-bottom:0;}
      .monaco-hover:has(a[data-href*="mixer.git.copyCommit"]) .markdown-hover p:first-child{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}
      .monaco-hover:has(a[data-href*="mixer.git.copyCommit"]) .markdown-hover p:first-child strong{font-weight:600;color:var(--mixer-git-link);}
      .monaco-hover:has(a[data-href*="mixer.git.copyCommit"]) .markdown-hover img{width:32px;height:32px;object-fit:cover;border-radius:0;margin-right:2px;}
      .monaco-hover:has(a[data-href*="mixer.git.copyCommit"]) a{color:var(--mixer-git-link)!important;text-decoration:none!important;}
      .monaco-hover:has(a[data-href*="mixer.git.copyCommit"]) a:hover{text-decoration:underline!important;}
      .monaco-hover:has(a[data-href*="mixer.git.copyCommit"]) hr{border:0;border-top:1px solid var(--mixer-git-border);margin:6px 0;}
      .monaco-hover:has(a[data-href*="mixer.git.copyCommit"]) .monaco-tokenized-source{display:block;box-sizing:border-box;border:1px solid var(--mixer-git-border);border-bottom:0;border-radius:6px 6px 0 0;padding:6px 7px;margin:4px -8px 0;overflow-x:auto;}
      .monaco-hover:has(a[data-href*="mixer.git.copyCommit"]) a:has(.codicon){display:inline-flex;align-items:center;justify-content:center;min-width:24px;min-height:24px;border-radius:4px;}
      .monaco-hover:has(a[data-href*="mixer.git.copyCommit"]) a:has(.codicon):hover{background:var(--mixer-git-badge);text-decoration:none!important;}
      .monaco-hover:has(a[data-href*="mixer.git.copyCommit"]) p code{background:var(--mixer-git-badge);border-radius:4px;padding:2px 6px;color:var(--mixer-git-link);}
      .monaco-hover:has(a[data-href*="mixer.git.copyCommit"]) p:has(a[data-href*="mixer.git.copyCommit"]){display:flex;align-items:center;gap:8px;margin-bottom:4px;}
      .monaco-hover:has(a[data-href*="mixer.git.copyCommit"]) p:has(a[data-href*="mixer.git.copyCommit"]) > a:first-child{background:var(--mixer-git-badge);padding:1px 6px;gap:6px;}
      .monaco-hover:has(a[data-href*="mixer.git.copyCommit"]) p:has(a[data-href*="mixer.git.copyCommit"]) code{background:transparent;padding:0;}
      .monaco-hover:has(a[data-href*="mixer.git.copyCommit"]) .codicon-link{color:var(--mixer-git-issue);}
      .monaco-hover:has(a[data-href*="mixer.git.copyCommit"]):has(.monaco-tokenized-source) .markdown-hover p:last-child{margin:0 -8px -6px;padding:6px 8px;border-top:1px solid var(--mixer-git-border);}
    `;
    document.head.append(style);
    this.disposables.push({ dispose: () => style.remove() });
    this.provider = {
      onDidChange: this.lensesChanged.event,
      provideCodeLenses: (target) => ({
        lenses: target === model ? this.codeLenses() : [],
        dispose() {},
      }),
    };
    this.disposables.push(monaco.languages.registerCodeLensProvider("*", this.provider));
    this.disposables.push(
      editor.onDidChangeCursorSelection(() => {
        const line = editor.getPosition()?.lineNumber ?? 0;
        const count = editor.getSelections()?.length ?? 0;
        if (line === this.renderedLine && count === this.renderedSelectionCount) return;
        this.renderLine();
      }),
    );
    this.disposables.push(
      model.onDidChangeContent(() => {
        this.generation++;
        this.blame = null;
        this.renderLine();
        this.lensesChanged.fire(this.provider);
        if (this.refreshTimer) clearTimeout(this.refreshTimer);
        this.refreshTimer = setTimeout(() => {
          this.refreshTimer = null;
          void this.refresh();
        }, 600);
      }),
    );
    this.disposables.push(
      editor.onDidFocusEditorText(() => {
        void this.refresh();
      }),
    );
    this.disposables.push(
      editor.addAction({
        id: REFRESH_GIT,
        label: "Refresh Git history",
        contextMenuGroupId: "git",
        run: () => {
          this.detailErrors.clear();
          this.details.clear();
          return this.refresh();
        },
      }),
    );
    this.disposables.push(
      editor.addAction({
        id: COPY_GIT_COMMIT,
        label: "Copy Git commit SHA",
        run: (_editor, sha: unknown) => {
          const parsed = gitObjectIdSchema.safeParse(sha ?? this.currentLine()?.commit.sha);
          if (parsed.success && !isUncommitted(parsed.data))
            options.emit({ type: "git-copy", text: parsed.data });
        },
      }),
    );
    this.disposables.push(
      editor.addAction({
        id: INSPECT_COMMIT,
        label: "Show latest file commit",
        run: () => {
          if (this.blame?.kind !== "ready") return;
          const { latestLine } = gitFileAuthorship(this.blame);
          editor.setPosition({
            lineNumber: latestLine,
            column: model.getLineMaxColumn(latestLine),
          });
          editor.revealLineInCenterIfOutsideViewport(latestLine);
          editor.focus();
          this.renderLine();
          editor.trigger("git", "editor.action.showHover", { focus: true });
        },
      }),
    );
    // Standalone addAction registers an editor-prefixed command ID. Markdown and
    // CodeLens use the public IDs, so route those through the bound editor action.
    for (const id of [COPY_GIT_COMMIT, INSPECT_COMMIT, REFRESH_GIT]) {
      const action = editor.getAction(id);
      if (!action) throw new Error(`Git editor action is unavailable: ${id}`);
      this.disposables.push(
        monaco.editor.registerCommand(id, (_accessor, ...args: unknown[]) => action.run(...args)),
      );
    }
    this.disposables.push(
      monaco.editor.registerLinkOpener({
        open: (resource) => {
          const url = resource.toString();
          if (
            ![...this.details.values()].some(
              (details) =>
                details.url === url ||
                details.pullRequest?.url === url ||
                details.authorProfileUrl === url,
            )
          )
            return false;
          options.emit({ type: "git-open", url: resource.toString() });
          return true;
        },
      }),
    );
    this.configure(options.configuration);
  }

  private get enabled(): boolean {
    const { gitBlame, gitCodeLens, gitHover } = this.configuration.preferences;
    return this.configuration.gitAnnotations && (gitBlame || gitCodeLens || gitHover);
  }

  configure(configuration: EditorConfiguration) {
    const previous = this.configuration;
    const wasEnabled = this.enabled;
    this.configuration = configuration;
    if (previous.filename !== configuration.filename) {
      this.generation++;
      this.blame = null;
      this.blameVersion = -1;
      this.details.clear();
      this.detailErrors.clear();
      this.detailRequests.clear();
      this.refreshing = null;
    }
    document.documentElement.style.setProperty(
      "--mixer-git-foreground",
      configuration.theme.foregroundMuted,
    );
    const dark = configuration.theme.colorScheme === "dark";
    document.documentElement.style.setProperty(
      "--mixer-git-background",
      dark ? "#191c1f" : "#ffffff",
    );
    document.documentElement.style.setProperty("--mixer-git-border", dark ? "#3b4045" : "#d0d7de");
    document.documentElement.style.setProperty("--mixer-git-link", dark ? "#79b8ff" : "#0969da");
    document.documentElement.style.setProperty("--mixer-git-badge", dark ? "#30363d" : "#eaeef2");
    document.documentElement.style.setProperty("--mixer-git-issue", dark ? "#b392f0" : "#8250df");
    this.renderLine();
    this.lensesChanged.fire(this.provider);
    if (
      this.enabled &&
      (!wasEnabled ||
        this.blameVersion !== this.options.model.getVersionId() ||
        previous.gitAnnotations !== configuration.gitAnnotations)
    )
      void this.refresh();
  }

  accept(response: Extract<EditorCommand, { type: "git-response" }>) {
    const pending = this.pending.get(response.requestId);
    if (!pending) return;
    this.pending.delete(response.requestId);
    clearTimeout(pending.timer);
    if (response.error) pending.reject(new Error(response.error));
    else {
      try {
        pending.resolve(response.result);
      } catch (error) {
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  private request<T>(
    event:
      | { type: "git-blame-request"; content: string }
      | { type: "git-commit-request"; sha: string },
    schema: z.ZodType<T>,
  ): Promise<T> {
    const requestId = crypto.randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("Git history request timed out"));
      }, 30_000);
      this.pending.set(requestId, {
        timer,
        resolve: (value) => resolve(schema.parse(value)),
        reject,
      });
      this.options.emit({ ...event, requestId });
    });
  }

  private refresh(): Promise<void> {
    if (this.disposed || this.options.model.isDisposed()) return Promise.resolve();
    const version = this.options.model.getVersionId();
    if (this.refreshing?.version === version) return this.refreshing.task;
    const task = this.loadBlame();
    this.refreshing = { version, task };
    void task.then(() => {
      if (this.refreshing?.task === task) this.refreshing = null;
      return undefined;
    });
    return task;
  }

  private async loadBlame() {
    if (!this.enabled || this.disposed || this.options.model.isDisposed()) return;
    const generation = ++this.generation;
    const version = this.options.model.getVersionId();
    this.surface()?.setAttribute("data-git-state", "loading");
    try {
      const blame = await this.request(
        { type: "git-blame-request", content: this.options.model.getValue() },
        editorGitBlameSchema,
      );
      if (
        this.disposed ||
        this.options.model.isDisposed() ||
        generation !== this.generation ||
        version !== this.options.model.getVersionId()
      )
        return;
      this.blame = blame;
      this.blameVersion = version;
      this.lines.clear();
      this.commits.clear();
      if (blame.kind === "ready") {
        for (const line of blame.lines) this.lines.set(line.line, line);
        for (const commit of blame.commits) this.commits.set(commit.sha, commit);
      }
      this.surface()?.setAttribute("data-git-state", blame.kind);
      this.surface()?.removeAttribute("data-git-error");
      this.renderLine();
      this.lensesChanged.fire(this.provider);
    } catch (error) {
      if (this.disposed || generation !== this.generation) return;
      this.blame = null;
      this.blameVersion = -1;
      this.lensesChanged.fire(this.provider);
      this.showError(error);
    }
  }

  private showError(error: unknown) {
    this.surface()?.setAttribute("data-git-state", "error");
    this.surface()?.setAttribute(
      "data-git-error",
      error instanceof Error ? error.message : String(error),
    );
    const position = this.options.editor.getPosition();
    if (position) {
      const column = this.options.model.getLineMaxColumn(position.lineNumber);
      this.decorations.set([
        {
          range: new monaco.Range(position.lineNumber, column, position.lineNumber, column),
          options: {
            showIfCollapsed: true,
            after: {
              content: "    Git history unavailable",
              inlineClassName: "mixer-git-inline",
              cursorStops: monaco.editor.InjectedTextCursorStops.None,
            },
            hoverMessage: {
              value: `${escapeGitMarkdown(error instanceof Error ? error.message : String(error))}\n\n[Retry Git history](command:${REFRESH_GIT})`,
              isTrusted: { enabledCommands: [REFRESH_GIT] },
            },
          },
        },
      ]);
    }
  }

  private surface() {
    return document.getElementById("editor");
  }

  private codeLenses(): monaco.languages.CodeLens[] {
    if (
      !this.enabled ||
      !this.configuration.preferences.gitCodeLens ||
      this.blame?.kind !== "ready"
    )
      return [];
    const { latest, authors } = gitFileAuthorship(this.blame);
    if (!latest || !authors.length) return [];
    const range = new monaco.Range(1, 1, 1, 1);
    return [
      {
        range,
        command: {
          id: INSPECT_COMMIT,
          title: `${latest.author}, ${relativeCommitTime(latest.authoredAt)}`,
        },
      },
      {
        range,
        command: {
          id: "",
          title: `${authors.length} ${authors.length === 1 ? "author" : "authors"} (${authors[0].name}${authors.length > 1 ? " and others" : ""})`,
        },
      },
    ];
  }

  private currentLine() {
    const { editor, model } = this.options;
    const position = editor.getPosition();
    if (
      this.disposed ||
      !this.enabled ||
      !position ||
      model.isDisposed() ||
      this.blame?.kind !== "ready" ||
      this.blameVersion !== model.getVersionId() ||
      editor.getSelections()?.length !== 1
    ) {
      return null;
    }
    const line = this.lines.get(position.lineNumber);
    const commit = line && this.commits.get(line.sha);
    return line && commit ? { line, commit, position } : null;
  }

  private showCapabilityHint(): boolean {
    if (
      this.disposed ||
      this.configuration.gitAnnotations ||
      !this.configuration.preferences.gitBlame ||
      this.options.model.isDisposed()
    )
      return false;
    const position = this.options.editor.getPosition();
    if (!position) return false;
    this.surface()?.setAttribute("data-git-state", "unsupported");
    this.surface()?.removeAttribute("data-git-line-author");
    this.surface()?.removeAttribute("data-git-commit");
    const column = this.options.model.getLineMaxColumn(position.lineNumber);
    this.decorations.set([
      {
        range: new monaco.Range(position.lineNumber, column, position.lineNumber, column),
        options: {
          showIfCollapsed: true,
          after: {
            content: "    Update host for Git history",
            inlineClassName: "mixer-git-inline",
            cursorStops: monaco.editor.InjectedTextCursorStops.None,
          },
          hoverMessage: {
            value:
              "Update the workspace host to enable Git authorship and commit details. File editing remains available.",
          },
        },
      },
    ]);
    return true;
  }

  private renderLine() {
    this.renderedLine = this.options.editor.getPosition()?.lineNumber ?? 0;
    this.renderedSelectionCount = this.options.editor.getSelections()?.length ?? 0;
    if (this.detailsTimer) clearTimeout(this.detailsTimer);
    this.detailsTimer = null;
    if (this.showCapabilityHint()) return;
    const current = this.currentLine();
    if (!current) {
      this.decorations.clear();
      this.surface()?.removeAttribute("data-git-line-author");
      this.surface()?.removeAttribute("data-git-commit");
      return;
    }
    const { line, commit, position } = current;
    const details = this.details.get(commit.sha);
    const column = this.options.model.getLineMaxColumn(position.lineNumber);
    const unavailable = this.detailErrors.get(commit.sha);
    const hover: monaco.IMarkdownString = {
      value:
        gitHoverMarkdown(commit, line.originalLine, details) +
        (unavailable ? `\n\n_Commit details unavailable: ${escapeGitMarkdown(unavailable)}_` : ""),
      isTrusted: { enabledCommands: [COPY_GIT_COMMIT, REFRESH_GIT] },
      supportThemeIcons: true,
      supportHtml: false,
    };
    this.decorations.set([
      {
        range: new monaco.Range(
          position.lineNumber,
          Math.max(1, column - 1),
          position.lineNumber,
          column,
        ),
        options: {
          showIfCollapsed: true,
          after: this.configuration.preferences.gitBlame
            ? {
                content: `    ${gitInlineText(commit, details)}`,
                inlineClassName: "mixer-git-inline",
                cursorStops: monaco.editor.InjectedTextCursorStops.None,
              }
            : undefined,
          hoverMessage: this.configuration.preferences.gitHover ? hover : undefined,
        },
      },
    ]);
    this.surface()?.setAttribute(
      "data-git-line-author",
      isUncommitted(commit.sha) ? "Not Committed Yet" : commit.author,
    );
    this.surface()?.setAttribute("data-git-commit", commit.sha);
    if (
      !isUncommitted(commit.sha) &&
      !details &&
      !unavailable &&
      this.configuration.preferences.gitHover
    ) {
      this.detailsTimer = setTimeout(() => {
        this.detailsTimer = null;
        void this.enrich(commit.sha);
      }, 750);
    }
  }

  private async enrich(sha: string) {
    const filename = this.configuration.filename;
    let task = this.detailRequests.get(sha);
    if (!task) {
      task = this.request({ type: "git-commit-request", sha }, editorGitCommitDetailsSchema);
      this.detailRequests.set(sha, task);
    }
    try {
      const details = await task;
      if (details.patch) await this.options.prepareDiffSyntax();
      if (this.detailRequests.get(sha) === task) this.detailRequests.delete(sha);
      if (this.disposed || filename !== this.configuration.filename) return;
      this.details.set(sha, details);
      if (this.details.size > 64) {
        const oldest = this.details.keys().next().value;
        if (oldest) this.details.delete(oldest);
      }
      this.renderLine();
    } catch (error) {
      if (this.detailRequests.get(sha) === task) this.detailRequests.delete(sha);
      if (this.disposed || filename !== this.configuration.filename) return;
      this.detailErrors.set(sha, error instanceof Error ? error.message : String(error));
      if (this.detailErrors.size > 64) {
        const oldest = this.detailErrors.keys().next().value;
        if (oldest) this.detailErrors.delete(oldest);
      }
      this.renderLine();
    }
  }

  dispose() {
    this.disposed = true;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    if (this.detailsTimer) clearTimeout(this.detailsTimer);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Git annotation view closed"));
    }
    this.pending.clear();
    this.decorations.clear();
    this.lensesChanged.dispose();
    for (const disposable of this.disposables) disposable.dispose();
  }
}
