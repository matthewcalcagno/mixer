/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useMenuState } from "./menu-context";

vi.mock("@/constants/layout", () => ({ useIsCompactFormFactor: () => false }));
vi.mock("@/constants/platform", () => ({
  getIsElectron: () => true,
  isWeb: true,
  isNative: false,
}));

describe("useMenuState form selection", () => {
  it("leaves the menu open for an item that does not close it", () => {
    const onSelect = vi.fn();
    const { result } = renderHook(() => useMenuState({ defaultOpen: true }));

    act(() => result.current.selectItem(onSelect, false));
    expect(result.current.open).toBe(true);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});

describe("useMenuState desktop selection", () => {
  it("runs a closing item's action immediately", () => {
    const onSelect = vi.fn();
    const { result } = renderHook(() => useMenuState({ defaultOpen: true }));

    act(() => result.current.selectItem(onSelect, true));
    expect(result.current.open).toBe(false);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});

describe("useMenuState pages", () => {
  it("pops the open page on Back and leaves Back at the root to the surface", () => {
    const { result } = renderHook(() => useMenuState({ defaultOpen: true }));
    act(() => result.current.openSub({ id: "row", depth: 0 }));

    let handled = false;
    act(() => {
      handled = result.current.goBack();
    });
    expect(handled).toBe(true);
    expect(result.current.path).toEqual([]);

    act(() => {
      handled = result.current.goBack();
    });
    expect(handled).toBe(false);
    expect(result.current.open).toBe(true);
  });

  it("falls back to the list when the open page's definition goes away", () => {
    const { result } = renderHook(() => useMenuState({ defaultOpen: true }));
    act(() => result.current.openSub({ id: "row", depth: 0 }));

    const keepNoPage = () => false;
    act(() => result.current.prunePages(keepNoPage));

    expect(result.current.path).toEqual([]);
    let handled = true;
    act(() => {
      handled = result.current.goBack();
    });
    expect(handled).toBe(false);
  });
});
