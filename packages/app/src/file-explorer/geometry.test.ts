import { describe, expect, it } from "vitest";
import { fileExplorerRevealOffset } from "./geometry";

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
