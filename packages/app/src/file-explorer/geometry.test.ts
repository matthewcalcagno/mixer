import { describe, expect, it } from "vitest";
import { fileExplorerRevealOffset } from "./geometry";
import { indexStickyTree, stickyFolders } from "./sticky-scroll";

describe("Explorer sticky folders", () => {
  const nodes = indexStickyTree([
    { depth: 0, directory: true },
    { depth: 1, directory: true },
    { depth: 2, directory: false },
    { depth: 2, directory: false },
    { depth: 1, directory: false },
    { depth: 0, directory: true },
    { depth: 1, directory: false },
    { depth: 1, directory: false },
    { depth: 0, directory: false },
  ]);
  const at = (scrollOffset: number, viewportHeight = 500) =>
    stickyFolders({ nodes, scrollOffset, viewportHeight, rowHeight: 22, paddingTop: 4 });

  it("pins only folders that have scrolled under the ancestor stack", () => {
    expect(at(0)).toEqual([]);
    expect(at(4)).toEqual([]);
    expect(at(5)).toEqual([
      { index: 0, top: 0 },
      { index: 1, top: 22 },
    ]);
    expect(at(48)).toEqual([
      { index: 0, top: 0 },
      { index: 1, top: 22 },
    ]);
  });

  it("pushes the innermost ancestor out at the end of its subtree", () => {
    expect(at(60)).toEqual([
      { index: 0, top: 0 },
      { index: 1, top: 10 },
    ]);
    expect(at(70)).toEqual([{ index: 0, top: 0 }]);
  });

  it("switches ancestry at sibling boundaries and never pins files or empty folders", () => {
    expect(at(114)).toEqual([]);
    expect(at(115)).toEqual([{ index: 5, top: 0 }]);
    expect(at(180)).toEqual([]);
  });

  it("bounds the overlay in a short or hidden viewport", () => {
    expect(at(48, 80)).toEqual([{ index: 0, top: 0 }]);
    expect(at(48, 0)).toEqual([]);
  });

  it("caps deep ancestor chains at seven folders", () => {
    const deep = indexStickyTree([
      ...Array.from({ length: 10 }, (_, depth) => ({ depth, directory: true })),
      { depth: 10, directory: false },
    ]);
    expect(
      stickyFolders({
        nodes: deep,
        scrollOffset: 5,
        viewportHeight: 1000,
        rowHeight: 22,
        paddingTop: 4,
      }),
    ).toEqual([
      { index: 0, top: 0 },
      { index: 1, top: 22 },
      { index: 2, top: 44 },
      { index: 3, top: 66 },
      { index: 4, top: 88 },
      { index: 5, top: 110 },
      { index: 6, top: 132 },
    ]);
  });
});

describe("fileExplorerRevealOffset", () => {
  it("preserves the scroll position for any fully visible row", () => {
    expect(
      fileExplorerRevealOffset({
        rowTop: 140,
        rowBottom: 162,
        viewportTop: 100,
        viewportBottom: 500,
        scrollOffset: 600,
      }),
    ).toBe(600);
    expect(
      fileExplorerRevealOffset({
        rowTop: 478,
        rowBottom: 500,
        viewportTop: 100,
        viewportBottom: 500,
        scrollOffset: 600,
      }),
    ).toBe(600);
  });
  it("reveals a row below the viewport with the smallest scroll", () => {
    expect(
      fileExplorerRevealOffset({
        rowTop: 490,
        rowBottom: 512,
        viewportTop: 100,
        viewportBottom: 500,
        scrollOffset: 600,
      }),
    ).toBe(612);
  });
  it("reveals a row above the viewport with the smallest scroll", () => {
    expect(
      fileExplorerRevealOffset({
        rowTop: 88,
        rowBottom: 110,
        viewportTop: 100,
        viewportBottom: 500,
        scrollOffset: 600,
      }),
    ).toBe(588);
  });
});
