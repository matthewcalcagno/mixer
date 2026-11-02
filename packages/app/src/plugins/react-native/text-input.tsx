import { forwardRef, useCallback, useEffect, useRef, type ElementRef } from "react";
import type { TextInputProps } from "react-native";

import { useRetainedPanelActive } from "@/components/retained-panel";

import type { SheetAwareTextInput } from "@/components/ui/text-input/sheet-aware";

export const TextInput = forwardRef<ElementRef<typeof SheetAwareTextInput>, TextInputProps>(
  function TextInput(props, ref) {
    const { SheetAwareTextInput } =
      require("../../components/ui/text-input/sheet-aware") as typeof import("../../components/ui/text-input/sheet-aware");
    const active = useRetainedPanelActive();
    const input = useRef<ElementRef<typeof SheetAwareTextInput> | null>(null);
    const setInput = useCallback(
      (node: ElementRef<typeof SheetAwareTextInput> | null) => {
        input.current = node;
        if (typeof ref === "function") ref(node);
        else if (ref) ref.current = node;
      },
      [ref],
    );
    useEffect(() => {
      if (!props.autoFocus || !active) return;
      // Wait until the retained panel has left display:none before focusing.
      const frame = requestAnimationFrame(() => input.current?.focus());
      return () => cancelAnimationFrame(frame);
    }, [active, props.autoFocus]);
    return <SheetAwareTextInput {...props} autoFocus={false} ref={setInput} />;
  },
);
