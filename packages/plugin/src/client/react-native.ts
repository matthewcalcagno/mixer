// COMPAT(pluginReactNativeEntrypoint): added in v0.13.0, remove after 2027-04-20
/** @deprecated Import Mixer UI from @mixer/plugin/client/ui. */
export * from "./ui.js";

/** @deprecated Render StreamedText from @mixer/plugin/client/ui. Removed after 2027-04-20 with this entry. */
export declare function useRevealedText(text: string, phase: "streaming" | "complete"): string;
