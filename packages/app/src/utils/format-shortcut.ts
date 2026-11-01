export type ShortcutKey = string;

export type ShortcutOs = "mac" | "non-mac";

/** One combination can be displayed by an OS menu; sequences stay app-owned. */
export function electronAccelerator(
  keys: readonly ShortcutKey[],
  os: ShortcutOs,
): string | undefined {
  const modifiers = new Map([
    ["mod", os === "mac" ? "Command" : "Control"],
    ["meta", os === "mac" ? "Command" : "Super"],
    ["ctrl", "Control"],
    ["shift", "Shift"],
    ["alt", "Alt"],
  ]);
  const names = new Map([
    ["Esc", "Escape"],
    ["ArrowLeft", "Left"],
    ["ArrowRight", "Right"],
    ["ArrowUp", "Up"],
    ["ArrowDown", "Down"],
    ["+", "Plus"],
  ]);
  const named = new Set([
    "Backspace",
    "Delete",
    "Insert",
    "Tab",
    "Enter",
    "Return",
    "Escape",
    "Space",
    "Home",
    "End",
    "PageUp",
    "PageDown",
    "Left",
    "Right",
    "Up",
    "Down",
    "Plus",
  ]);
  const prefixes = new Set<string>();
  const main: string[] = [];
  for (const key of keys) {
    const modifier = modifiers.get(key);
    if (modifier) prefixes.add(modifier);
    else main.push(names.get(key) ?? key);
  }
  const key = main[0];
  if (
    main.length !== 1 ||
    !key ||
    !(named.has(key) || /^[!-~]$/.test(key) || /^F(?:[1-9]|1\d|2[0-4])$/.test(key))
  )
    return undefined;
  return [...prefixes, key].join("+");
}

const KEY_DISPLAY: Record<string, string> = {
  Backspace: "⌫",
  Enter: "⏎",
  Esc: "Esc",
  Space: "␣",
  Left: "←",
  Right: "→",
  Up: "↑",
  Down: "↓",
};

function normalizeKey(key: string): string {
  if (!key) return "";
  if (KEY_DISPLAY[key]) return KEY_DISPLAY[key];
  if (key.length === 1) return key.toUpperCase();
  return key;
}

export function formatShortcut(keys: ShortcutKey[], os: ShortcutOs): string {
  const normalized = keys.map((k) => (typeof k === "string" ? k : String(k)));

  if (os === "mac") {
    const order = ["ctrl", "alt", "shift", "mod", "meta"];
    const symbols: Record<string, string> = {
      mod: "⌘",
      shift: "⇧",
      alt: "⌥",
      ctrl: "⌃",
      meta: "⌘",
    };

    const modifierSet = new Set(normalized);
    const mods = order.filter((k) => modifierSet.has(k)).map((k) => symbols[k] ?? "");
    const main = normalized
      .filter((k) => !order.includes(k))
      .map(normalizeKey)
      .join("");
    return `${mods.join("")}${main}`;
  }

  const labels: Record<string, string> = {
    mod: "Ctrl",
    shift: "Shift",
    alt: "Alt",
    ctrl: "Ctrl",
    meta: "Win",
  };
  return normalized
    .map((k) => labels[k] ?? normalizeKey(k))
    .filter(Boolean)
    .join("+");
}
