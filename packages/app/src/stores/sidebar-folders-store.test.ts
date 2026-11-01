import { describe, expect, it } from "vitest";
import {
  reduceSidebarFolders,
  resolveSidebarRootKeys,
  insertSidebarRootKey,
} from "./sidebar-folders-store";

describe("sidebar project folders", () => {
  it("places a root project before or after a folder without assigning it to the folder", () => {
    expect(
      insertSidebarRootKey({
        keys: ["folder:clients", "project"],
        key: "project",
        target: "folder:clients",
        placement: "before",
      }),
    ).toEqual(["project", "folder:clients"]);
    expect(
      insertSidebarRootKey({
        keys: ["project", "folder:clients"],
        key: "project",
        target: "folder:clients",
        placement: "after",
      }),
    ).toEqual(["folder:clients", "project"]);
  });
  it("preserves folders between root projects and excludes nested projects", () => {
    expect(
      resolveSidebarRootKeys({
        folders: [{ id: "clients", name: "Clients", collapsed: false, projectKeys: ["nested"] }],
        projectKeys: ["one", "two", "nested"],
        order: ["one", "folder:clients", "two"],
      }),
    ).toEqual(["one", "folder:clients", "two"]);
  });
  it("ignores missing entries without dropping newly added root items", () => {
    expect(
      resolveSidebarRootKeys({
        folders: [],
        projectKeys: ["one", "two"],
        order: ["missing", "two"],
      }),
    ).toEqual(["two", "one"]);
  });
  const initial = {
    folders: [
      { id: "one", name: "Work", collapsed: false, projectKeys: ["project-a", "project-b"] },
      { id: "two", name: "Personal", collapsed: true, projectKeys: [] },
    ],
  };
  it("moves a project to exactly one folder without moving other projects", () => {
    const state = reduceSidebarFolders(initial, {
      kind: "move",
      projectKey: "project-a",
      folderId: "two",
    });
    expect(state.folders.map((folder) => folder.projectKeys)).toEqual([
      ["project-b"],
      ["project-a"],
    ]);
    expect(state.folders[1].collapsed).toBe(false);
    expect(
      reduceSidebarFolders(state, { kind: "move", projectKey: "project-a", folderId: "two" }),
    ).toEqual(state);
  });
  it("moves a project back to the root and preserves its exact key", () => {
    const state = reduceSidebarFolders(initial, {
      kind: "move",
      projectKey: "host:/project ",
      folderId: "two",
    });
    expect(state.folders[1].projectKeys).toEqual(["host:/project "]);
    expect(
      reduceSidebarFolders(state, { kind: "move", projectKey: "host:/project ", folderId: null })
        .folders[1].projectKeys,
    ).toEqual([]);
  });
  it("does not lose a project when an open menu references a removed folder", () => {
    expect(
      reduceSidebarFolders(initial, { kind: "move", projectKey: "project-a", folderId: "missing" }),
    ).toEqual(initial);
  });
  it("removes only the folder and its assignments", () => {
    expect(reduceSidebarFolders(initial, { kind: "remove", id: "one" })).toEqual({
      folders: [{ id: "two", name: "Personal", collapsed: true, projectKeys: [] }],
    });
  });
  it("renames and collapses independently of project membership", () => {
    const renamed = reduceSidebarFolders(initial, { kind: "rename", id: "one", name: " Clients " });
    const collapsed = reduceSidebarFolders(renamed, { kind: "toggle", id: "one" });
    expect(collapsed.folders[0]).toEqual({
      id: "one",
      name: "Clients",
      collapsed: true,
      projectKeys: ["project-a", "project-b"],
    });
  });
  it("rejects blank names and creates an empty expanded folder", () => {
    expect(() =>
      reduceSidebarFolders(initial, { kind: "create", id: "three", name: " " }),
    ).toThrow();
    expect(
      reduceSidebarFolders({ folders: [] }, { kind: "create", id: "three", name: "New folder" }),
    ).toEqual({
      folders: [{ id: "three", name: "New folder", collapsed: false, projectKeys: [] }],
    });
  });
});
