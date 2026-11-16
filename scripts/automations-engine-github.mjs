// Keep the deleted-cursor regression in the import path so engine refreshes retain it.
export function adaptGitHubEventPolling(file, text) {
  if (file === "docs/github.md") {
    const before =
      "When a saved cursor is absent from the fetched event pages, RoboPlane replays available events oldest-first and records a possible history gap.";
    if (!text.includes(before))
      throw new Error("Review the upstream GitHub history-gap documentation seam.");
    return text.replace(
      before,
      "GitHub can remove events when their comments are deleted, so polling retains up to 100 processed event IDs as restart-safe history boundaries. Startup also retains the first page of skipped historical events. If the saved cursor disappears, polling resumes at the first surviving boundary without replaying older events or recording a gap. When no retained boundary is present in the fetched pages, RoboPlane replays available events oldest-first and records a possible history gap.",
    );
  }
  if (file === "packages/extension-github/src/index.ts") {
    for (const [before, after] of pollingChanges) {
      if (!text.includes(before))
        throw new Error("Review the upstream GitHub polling continuity seam.");
      text = text.replace(before, after);
    }
    return text;
  }
  if (file !== "packages/extension-github/src/index.test.ts") return text;
  const marker =
    '  it("replays available events oldest-first when the cursor is missing instead of discarding the batch", async () => {';
  if (!text.includes(marker)) throw new Error("Review the upstream GitHub polling test seam.");
  return text.replace(
    marker,
    `${deletedCursorTest}\n${initialCursorTest}\n${checkpointSafetyTest}\n${marker}`,
  );
}

const pollingChanges = [
  [
    "const cursor = state.get<string>(key);",
    `const cursor = state.get<string>(key);
              // GitHub removes events for deleted comments. Keep multiple processed
              // boundaries rather than treating one disappearing event as lost history.
              const checkpointKey = \`events:\${repository}:checkpoint\`;
              const stored = state.get(checkpointKey);
              const checkpoint = stored === undefined ? undefined : z.object({
                cursor: z.string(), anchors: z.array(z.string()).max(100),
              }).parse(stored);
              let anchors = checkpoint && checkpoint.cursor === cursor ? checkpoint.anchors : cursor ? [cursor] : [];
              const acknowledge = (id: string) => {
                anchors = [id, ...anchors.filter(anchor => anchor !== id)].slice(0, 100);
                // A crash between writes leaves a mismatched checkpoint, which is
                // ignored above instead of trusting an uncommitted boundary.
                state.set(checkpointKey, { cursor: id, anchors });
                state.set(key, id);
              };`,
  ],
  [
    "if (event.id === cursor) { foundCursor = true; break; }",
    "if (event.id === cursor || anchors.includes(event.id)) { foundCursor = true; break; }",
  ],
  ["`/repos/${repository}/events?per_page=1`", "`/repos/${repository}/events?per_page=100`"],
  [
    "if (initial[0]) state.set(key, initial[0].id);",
    `if (initial[0]) {
                  // Startup deliberately skips existing history; any of those events
                  // can establish that same boundary if the newest one is deleted.
                  anchors = initial.map(event => event.id).slice(0, 100);
                  acknowledge(initial[0].id);
                }`,
  ],
  ["state.set(key, raw.id);", "acknowledge(raw.id);"],
];

const deletedCursorTest = `  it.each([1, 2])("resumes after %i processed comment events disappear across restart without reporting a history gap", async (deleted) => {
    const state = new Map<string, unknown>([[cursorKey, "0"]]);
    let events = [repositoryComment("3"), repositoryComment("2"), repositoryComment("1"), { id: "0", type: "Unsupported" }];
    const emitted: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/events?")) return ok(events);
      if (url.endsWith("/user")) return ok({ login: "maintainer", id: 1 });
      throw new Error(\`unexpected request \${url}\`);
    }));
    const first = await startPoller(state, async (event) => { emitted.push(event.id); return true; });
    try {
      await vi.waitFor(() => expect(state.get(cursorKey)).toBe("3"));
      expect(emitted).toEqual(["github:owner/repo:1", "github:owner/repo:2", "github:owner/repo:3"]);
    } finally { first.stop(); }
    events = [repositoryComment("4"), ...events.slice(deleted)];
    emitted.length = 0;
    const restarted = await startPoller(state, async (event) => { emitted.push(event.id); return true; });
    try {
      await vi.waitFor(() => expect(restarted.reportHealth).toHaveBeenCalled());
      expect(emitted).toEqual(["github:owner/repo:4"]);
      expect(state.get(cursorKey)).toBe("4");
      expect(state.get("events:owner/repo:gap")).toBeUndefined();
      expect(restarted.reportHealth).toHaveBeenLastCalledWith(expect.objectContaining({ status: "ready", result: "success" }));
    } finally { restarted.stop(); }
  });
`;

const initialCursorTest = `  it("retains startup history boundaries when the initial cursor event is deleted", async () => {
    const state = new Map<string, unknown>();
    let events = [repositoryComment("3"), repositoryComment("2"), repositoryComment("1")];
    const emitted: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/events?")) return ok(events);
      if (url.endsWith("/user")) return ok({ login: "maintainer", id: 1 });
      throw new Error(\`unexpected request \${url}\`);
    }));
    const first = await startPoller(state, async (event) => { emitted.push(event.id); return true; });
    try {
      await vi.waitFor(() => expect(state.get(cursorKey)).toBe("3"));
      expect(emitted).toEqual([]);
    } finally { first.stop(); }
    events = [repositoryComment("4"), repositoryComment("2"), repositoryComment("1")];
    const restarted = await startPoller(state, async (event) => { emitted.push(event.id); return true; });
    try {
      await vi.waitFor(() => expect(restarted.reportHealth).toHaveBeenCalled());
      expect(emitted).toEqual(["github:owner/repo:4"]);
      expect(state.get(cursorKey)).toBe("4");
      expect(state.get("events:owner/repo:gap")).toBeUndefined();
      expect(restarted.reportHealth).toHaveBeenLastCalledWith(expect.objectContaining({ status: "ready", result: "success" }));
    } finally { restarted.stop(); }
  });
`;

const checkpointSafetyTest = `  it.each([
    { checkpointCursor: "2", ids: ["4"], expected: ["github:owner/repo:4"] },
    { checkpointCursor: "uncommitted", ids: ["4", "1"], expected: ["github:owner/repo:1", "github:owner/repo:4"] },
  ])("reports a real gap when checkpoint $checkpointCursor cannot establish continuity", async ({ checkpointCursor, ids, expected }) => {
    const state = new Map<string, unknown>([
      [cursorKey, "2"],
      ["events:owner/repo:checkpoint", { cursor: checkpointCursor, anchors: [checkpointCursor, "1"] }],
    ]);
    // A matching checkpoint has no surviving anchor; a mismatched checkpoint's
    // apparent overlap must not let an uncommitted event become a boundary.
    const events = ids.map(repositoryComment);
    const emitted: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/events?")) return ok(events);
      if (url.endsWith("/user")) return ok({ login: "maintainer", id: 1 });
      throw new Error(\`unexpected request \${url}\`);
    }));
    const poller = await startPoller(state, async (event) => { emitted.push(event.id); return true; });
    try {
      await vi.waitFor(() => expect(poller.reportHealth).toHaveBeenCalled());
      expect(emitted).toEqual(expected);
      expect(state.get(cursorKey)).toBe("4");
      expect(state.get("events:owner/repo:gap")).toMatchObject({ cursor: "2", newestAvailable: "4" });
      expect(poller.reportHealth).toHaveBeenLastCalledWith(expect.objectContaining({ status: "degraded", result: "success", reason: "github_event_history_gap" }));
    } finally { poller.stop(); }
  });
`;
