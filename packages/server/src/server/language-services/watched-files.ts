import path from "node:path";
import { homedir } from "node:os";
import { stat, realpath } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Minimatch } from "minimatch";
import { z } from "zod";
import type { FileObserver, FileObserverSubscription, FileChange } from "../file-observer/index.js";

const watcher = z.object({
  globPattern: z.union([
    z.string().min(1).max(4096),
    z.object({
      baseUri: z.union([z.string(), z.object({ uri: z.string() })]),
      pattern: z.string().min(1).max(4096),
    }),
  ]),
  kind: z.number().int().min(1).max(7).optional(),
});
interface CompiledWatcher {
  base: string;
  root: string;
  absolute: boolean;
  matcher: Minimatch;
  kind: number;
}
function inside(root: string, filename: string): boolean {
  const relative = path.relative(root, filename);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Native observations start only for registered roots, including bounded dependency-library roots. */
export class LanguageWatchedFiles {
  private registrations = new Map<string, CompiledWatcher[]>();
  private subscriptions = new Map<string, FileObserverSubscription>();
  private closed = false;
  constructor(
    private readonly workspaceRoot: string,
    private readonly observer: FileObserver,
    private readonly ignoredDirectories: string[],
    private readonly notify: (changes: { uri: string; type: number }[]) => void,
    private readonly onError: (error: Error) => void,
  ) {}

  async register(id: string, options: unknown): Promise<void> {
    if (this.closed) throw new Error("Language file observation is closed");
    const { watchers } = z.object({ watchers: z.array(watcher).max(256) }).parse(options);
    if (!this.registrations.has(id) && this.registrations.size >= 128)
      throw new Error("Too many file-watch registrations");
    const compiled = await Promise.all(watchers.map((entry) => this.compile(entry)));
    const previous = this.registrations.get(id);
    this.registrations.set(id, compiled);
    try {
      await this.refresh();
    } catch (error) {
      if (previous) this.registrations.set(id, previous);
      else this.registrations.delete(id);
      await this.refresh();
      throw error;
    }
  }

  private async compile(entry: z.infer<typeof watcher>): Promise<CompiledWatcher> {
    const glob = entry.globPattern;
    let base = this.workspaceRoot;
    const pattern = typeof glob === "string" ? glob : glob.pattern;
    const absolute = path.isAbsolute(pattern);
    if (typeof glob !== "string")
      base = fileURLToPath(typeof glob.baseUri === "string" ? glob.baseUri : glob.baseUri.uri);
    let root = base;
    if (absolute) {
      const firstGlob = pattern.search(/[*?{[(]/);
      const prefix = firstGlob === -1 ? pattern : pattern.slice(0, firstGlob);
      root = firstGlob !== -1 && prefix.endsWith(path.sep) ? prefix : path.dirname(prefix);
    }
    root = await this.existingRoot(root);
    if (root !== this.workspaceRoot && (root === path.parse(root).root || root === homedir()))
      throw new Error("Language servers cannot watch an entire filesystem or home directory");
    return {
      base,
      root,
      absolute,
      kind: entry.kind ?? 7,
      matcher: new Minimatch(pattern.split(path.sep).join("/"), {
        dot: true,
        nocase: process.platform === "win32",
      }),
    };
  }

  private async existingRoot(directory: string): Promise<string> {
    let candidate = path.resolve(directory);
    while (true) {
      try {
        const resolved = await realpath(candidate);
        if ((await stat(resolved)).isDirectory()) return resolved;
        candidate = path.dirname(candidate);
      } catch (error) {
        if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT")
          throw error;
        const parent = path.dirname(candidate);
        if (parent === candidate) throw error;
        candidate = parent;
      }
    }
  }

  private roots(): string[] {
    const roots = [
      ...new Set(
        [...this.registrations.values()].flatMap((entries) => entries.map((entry) => entry.root)),
      ),
    ].sort((a, b) => a.length - b.length);
    const selected: string[] = [];
    for (const root of roots)
      if (!selected.some((parent) => inside(parent, root))) selected.push(root);
    if (selected.length > 16)
      throw new Error("A language server may watch at most 16 separate roots");
    return selected;
  }

  private async refresh(): Promise<void> {
    const roots = this.roots();
    for (const root of roots) {
      if (this.subscriptions.has(root) || this.closed) continue;
      const subscription = await this.observer.subscribe(
        root,
        (error, events) => {
          if (this.closed) return;
          if (error) this.onError(error);
          else this.changed(events);
        },
        { ignore: this.ignoredDirectories.map((directory) => path.resolve(root, directory)) },
      );
      if (this.closed) await subscription.unsubscribe();
      else this.subscriptions.set(root, subscription);
    }
    for (const [root, subscription] of this.subscriptions)
      if (!roots.includes(root)) {
        this.subscriptions.delete(root);
        await subscription.unsubscribe();
      }
  }

  private changed(events: FileChange[]): void {
    const changes = events.flatMap((event) => {
      const type = { create: 1, update: 2, delete: 3 }[event.type];
      const matches = [...this.registrations.values()].some((entries) =>
        entries.some(
          (entry) =>
            (entry.kind & (1 << (type - 1))) !== 0 &&
            (entry.absolute || inside(entry.base, event.path)) &&
            entry.matcher.match(
              (entry.absolute ? event.path : path.relative(entry.base, event.path))
                .split(path.sep)
                .join("/"),
            ),
        ),
      );
      return matches ? [{ uri: pathToFileURL(event.path).href, type }] : [];
    });
    if (changes.length) this.notify(changes);
  }

  async unregister(id: string): Promise<void> {
    this.registrations.delete(id);
    await this.refresh();
  }
  async dispose(): Promise<void> {
    this.closed = true;
    this.registrations.clear();
    const subscriptions = [...this.subscriptions.values()];
    this.subscriptions.clear();
    await Promise.all(subscriptions.map((subscription) => subscription.unsubscribe()));
  }
}
