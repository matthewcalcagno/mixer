/**
 * @vitest-environment jsdom
 */
import React, { createRef } from "react";
import { act, render, renderHook } from "@testing-library/react";
import { Text, type View } from "react-native";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MenuRoot, MenuTrigger } from "./menu-root";
import { useMenuState } from "./menu-context";

vi.mock("@/constants/layout", () => ({ useIsCompactFormFactor: () => false }));
vi.mock("@/constants/platform", () => ({
  getIsElectron: () => true,
  isWeb: true,
  isNative: false,
}));

beforeEach(() => vi.stubGlobal("React", React));

describe("MenuTrigger", () => {
  it("starts a fresh OS menu after a form closes and reopens in the same update", () => {
    const { result } = renderHook(() => useMenuState({}));
    act(() => result.current.setOpen(true));
    act(() => result.current.openNativeForm(["create"]));
    expect(result.current.presentation).toBe("dialog");
    act(() => {
      result.current.setOpen(false);
      result.current.setOpen(true);
    });
    expect(result.current.open).toBe(true);
    expect(result.current.presentation).toBe("native");
    expect(result.current.nativeFormDepth).toBeNull();
    expect(result.current.path).toEqual([]);
  });
  it("forwards its rendered trigger to callers", () => {
    const triggerRef = createRef<View>();

    render(
      <MenuRoot>
        <MenuTrigger ref={triggerRef} accessibilityLabel="Open menu">
          <Text>Open</Text>
        </MenuTrigger>
      </MenuRoot>,
    );

    expect(triggerRef.current).not.toBeNull();
  });
});
