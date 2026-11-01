import { expect, it } from "vitest";
import { StartupReadiness } from "./startup-readiness";

it("waits for each essential task, including two visible editors", () => {
  const startup = new StartupReadiness();
  const fonts = startup.hold("Fonts");
  const editorOne = startup.hold("Editor");
  const editorTwo = startup.hold("Editor");
  startup.complete();
  expect(startup.getSnapshot().completed).toBe(false);
  fonts();
  editorOne();
  editorOne();
  expect(startup.getSnapshot().pending).toEqual(["Editor"]);
  editorTwo();
  startup.complete();
  expect(startup.getSnapshot().completed).toBe(true);
});
it("does not gate editors opened after the window has been revealed", () => {
  const startup = new StartupReadiness();
  startup.complete();
  startup.hold("Later editor");
  expect(startup.getSnapshot().pending).toEqual([]);
  expect(startup.getSnapshot().completed).toBe(true);
});
it("unmounted loaders release their startup demand", () => {
  const startup = new StartupReadiness();
  const release = startup.hold("Initial route");
  release();
  expect(startup.getSnapshot().pending).toEqual([]);
});
