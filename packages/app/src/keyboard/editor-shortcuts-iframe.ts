import {
  buildEffectiveBindings,
  resolveKeyboardShortcut,
  type ChordState,
} from "./keyboard-shortcuts";
import {
  EDITOR_LAYOUT_ACTIONS,
  EditorShortcutPolicyMessageSchema,
  type EditorShortcutPolicy,
} from "./editor-layout-shortcuts";
import { isImeComposingKeyboardEvent } from "../utils/keyboard-ime";

/** The diff editor keeps its opaque sandbox origin; only layout shortcuts leave the frame. */
export function installEditorLayoutShortcuts(): () => void {
  let policy: EditorShortcutPolicy | null = null;
  let bindings = buildEffectiveBindings({}).filter((binding) =>
    EDITOR_LAYOUT_ACTIONS.has(binding.action),
  );
  let chord: ChordState = { candidateIndices: [], step: 0, timeoutId: null };
  function reset() {
    if (chord.timeoutId) clearTimeout(chord.timeoutId);
    chord = { candidateIndices: [], step: 0, timeoutId: null };
  }
  function receive(event: MessageEvent<unknown>) {
    if (event.source !== window.parent) return;
    const parsed = EditorShortcutPolicyMessageSchema.safeParse(event.data);
    if (!parsed.success) return;
    reset();
    policy = parsed.data.policy;
    bindings = buildEffectiveBindings(policy.overrides).filter((binding) =>
      EDITOR_LAYOUT_ACTIONS.has(binding.action),
    );
  }
  function keyDown(event: KeyboardEvent) {
    if (!policy || isImeComposingKeyboardEvent(event)) return;
    const hadPrefix = chord.step > 0;
    const result = resolveKeyboardShortcut({
      event,
      context: {
        isMac: policy.isMac,
        isDesktop: policy.isDesktop,
        focusScope: "editable",
        commandCenterOpen: false,
      },
      chordState: chord,
      onChordReset: reset,
      bindings,
    });
    chord = result.nextChordState;
    if (result.preventDefault || result.match) {
      event.preventDefault();
      event.stopPropagation();
    }
    if (result.preventDefault || result.match || hadPrefix)
      window.parent.postMessage(
        {
          source: "mixer-editor-shortcuts",
          type: "input",
          input: {
            key: event.key,
            code: event.code,
            altKey: event.altKey,
            ctrlKey: event.ctrlKey,
            metaKey: event.metaKey,
            shiftKey: event.shiftKey,
            repeat: event.repeat,
          },
        },
        "*",
      );
  }
  window.addEventListener("message", receive);
  window.addEventListener("keydown", keyDown, true);
  return () => {
    reset();
    window.removeEventListener("message", receive);
    window.removeEventListener("keydown", keyDown, true);
  };
}
