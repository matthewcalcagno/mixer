# Compact desktop panels

Compact layouts have three mutually exclusive destinations:

- `agent-list` on the left
- `agent` in the center
- `file-explorer` on the right

They are one interaction, not two independent drawers. The implementation lives in
`packages/app/src/mobile-panels/`. The directory retains its historical name, but
these surfaces now serve narrow desktop windows only. There are no mobile app targets.

## Ownership

React/Zustand owns the durable intent:

```ts
interface MobilePanelSelection {
  target: "agent-list" | "agent" | "file-explorer";
  revision: number;
}
```

Every semantic target change increments `revision`. Repeating the current target is idempotent.
Compact panel selection is not persisted; a cold start begins at `agent`.

The UI worklet owns transient motion:

- one normalized position (`-1` left, `0` center, `1` right)
- the current motion target
- the active gesture's starting revision
- the last settled target

React publishes the active panel only when the canonical target and the UI-thread position agree at
the final anchor. Retained content never observes gesture previews, progress, or an unsettled target.
The gesture hosts stay mounted. The Gesture Handler web patch keeps initially disabled hosts
from capturing paragraph pointers; that capture confines browser selection to its starting paragraph.
Reanimated owns transient overlay motion while React owns settled panel activity
and accessibility. Keep panel hosts stable across appearance hydration and settings
changes. See [Unistyles appearance boundaries](unistyles.md#runtime-theme-patching-for-user-preferences).

## Why one position

Both transforms and both backdrop opacities are derived from the same normalized position. Window
width is only a projection input. Resizing changes the projection, not the panel state.

This makes these invalid states unrepresentable:

- a panel and its backdrop disagreeing
- left and right drawers both claiming to be open
- a width-sync effect resetting an active drag
- one animation context settling a transition owned by the other

Do not add another panel translate shared value, backdrop shared value, or width synchronization
effect.

## Ordering and interruption

A gesture captures the current revision when it becomes active. Per-frame updates are accepted only
while that revision still owns the gesture.

When a React command arrives during a drag, its newer revision clears gesture ownership and starts
motion toward the new target. The older gesture's remaining updates and finish callback are ignored.
Canceled gestures return to the latest canonical target. A successful gesture starts its finishing
motion immediately; the matching React command adopts that motion instead of restarting it. Position
settlement and command acceptance may arrive in either order. Activity changes after both agree on
the same target.

Manual gesture arbitration has two phases:

1. Before activation, determine whether horizontal intent may begin.
2. After activation, stop running begin checks and let the active revision own updates.

Re-running the begin gate after activation self-cancels the gesture because an active gesture is, by
definition, no longer eligible to begin.

## Integration rules

- Callers request semantic targets through `panel-store`; they never write shared values.
- Gesture behavior comes from the four explicit hooks in `mobile-panels/gestures.ts`.
- A focused interactive surface may block panel-opening gestures through
  `useBlockMobilePanelOpenGestures`. Register only while the conflicting interaction is active and
  unregister when the surface is hidden or unfocused. The blocker never disables gestures that close
  an already-open panel.
- Keep `SidebarModelProvider` outside `MobileGestureWrapper` so sidebar derivation is shared
  across consumers.
- Compact sidebars render through `MobilePanelOverlay`; do not duplicate overlay lifecycle or motion
  styles in sidebar components.
- The desktop left sidebar is retained too. App chrome owns separate mounted and visible decisions:
  closing it or yielding its width marks it inactive and applies `display: none` without conditionally
  removing the sidebar tree.
- Gesture start and progress must not update React state. The retained overlay is already mounted and
  offscreen; only the shared position and its derived styles move during a drag.
- Hidden tabs and workspaces use `RetainedPanel`. It owns the retained root, visibility,
  pointer events, and the active signal consumed by `useRetainedPanelActive`.
- Panels whose gesture wrapper already owns visibility use `RetainedPanelActivity` to provide the
  same active signal without adding another layout root. Persistent animations, timers, polling, and
  shared clocks must subscribe to that signal and stop when their final visible consumer leaves.
- Synchronized step animations use one wall-clock-aligned source. Register a local shared value only
  while its retained panel is active so hidden animated styles remain mounted without receiving clock
  updates. Do not give every instance its own loop or leave hidden styles subscribed to the source.
- Retention order and render order are separate concerns. LRU metadata may change on every switch;
  keyed retained roots must keep a stable sibling order.
- `useIsMobilePanelActive` follows the settled target, not the requested target. Position at the
  canonical target's anchor is the settlement signal; animation duration and completion callbacks
  do not own activity. Cancellation publishes nothing.
- Hidden chat content is suspended through `panels/retained-chat-content.tsx`. Keep subscriptions
  and selectors stable, and use the retained-panel active signal to stop timers, polling, and
  other background work.

## Tests

`packages/app/src/mobile-panels/model.test.ts` exercises command, drag, cancellation, interruption,
rapid-command, position-settlement, and width-projection sequences through the transition model. Add
a sequence there whenever ownership or ordering changes.
