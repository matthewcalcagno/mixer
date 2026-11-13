// Keep the pinned source's file paths and persisted storage names stable. Rename the
// public protocol, authoring SDK, and workflow helper together at import time.
export function namespaceAutomationEngine(source) {
  return source
    .replace(/ROBOPLANE(?=_|\b)/g, "MIXER_AUTOMATIONS")
    .replaceAll("@roboplane/sdk", "@mixer/automations-sdk")
    .replaceAll("RoboPlaneAPI", "MixerAutomationsAPI")
    .replaceAll('"roboplane"', '"mixer-automations"')
    .replaceAll("'roboplane'", "'mixer-automations'")
    .replace(/(?<![/@\w.-])roboplane(?=[ \t])/g, "mixer-automations")
    .replace(/\bRoboPlane\b/g, "Mixer Automations");
}
