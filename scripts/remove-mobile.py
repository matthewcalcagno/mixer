#!/usr/bin/env python3
"""Remove mobile targets and select the desktop renderer implementations.

Run without flags to review the plan. --apply archives every affected source file
before deleting anything. Dependencies, runtime state and build output are excluded.
"""
import argparse
import json
import os
from pathlib import Path
import re
import tempfile
import zipfile
import shutil

ROOT = Path(__file__).resolve().parent.parent
SKIP = {"node_modules", ".dev", ".tmp", ".expo", "dist", "build", "release", ".git", "test-results", "__pycache__"}
REMOVE = [
    "packages/app/ios", "packages/app/android", "packages/app/modules",
    "packages/app/plugins", "packages/app/fastlane", "packages/app/maestro",
    "packages/app/.eas", "packages/app/eas.json", "packages/app/Gemfile",
    "packages/app/Gemfile.lock", "packages/app/native-release-version.js",
    "packages/app/native-release-version.test.ts", "packages/app/e2e/mobile",
    "packages/app/scripts/verify-android-ndk.gradle", "packages/app/src/fdroid",
    "packages/expo-two-way-audio", "fastlane", "assets/store-screenshots",
    ".github/workflows/android-apk-release.yml", "docs/android.md",
    "docs/mobile-testing.md", "docs/native-text-selection.md",
    "scripts/build-apk.mjs", "scripts/seed-ios-native-cache.mjs",
    "scripts/mixer-ios-simulator-service.mjs", "scripts/mixer-ios-simulator-service.sh",
    "scripts/test-mobile-agent-device.sh", "scripts/sync-fdroid-changelogs.mjs",
    "scripts/sync-fdroid-changelogs.test.mjs",
    "packages/app/src/push-notifications", "packages/app/src/hosts/pair-scan-model.ts",
    "packages/app/src/hosts/pair-scan-model.test.ts",
    "packages/app/src/hooks/hardware-keyboard-submit-controller.ts",
    "packages/app/src/hooks/hardware-keyboard-submit-controller.test.ts",
    "packages/app/src/constants/build-profile.ts",
    "packages/app/src/attachments/native",
    "packages/app/src/attachments/attachment-file-system.ts",
    "packages/app/src/attachments/test-attachment-file-system.ts",
    "packages/app/src/attachments/local-file-attachment-store.ts",
    "packages/app/src/attachments/local-file-attachment-store.test.ts",
    "packages/app/src/audio/file-playback.ts", "packages/app/src/audio/play-audio.test.ts",
    "packages/app/src/watchdog", "packages/app/src/performance/native-trace.ts",
    "patches/@mattermost+react-native-paste-input+2.0.1.patch",
    "packages/app/src/desktop/components/pair-device-modal.tsx",
    "packages/app/src/desktop/components/pair-device-section.tsx",
    "packages/app/e2e/support/helpers/pair-device.ts",
    "packages/app/e2e/browser/pair-device-relay.spec.ts",
    "packages/server/src/server/push",
    "packages/app/src/terminal/native-renderer",
    "packages/app/src/agent-stream/strategy-native.tsx",
    "packages/app/src/keyboard/shift/internal/stream.ts",
    "packages/website/src/components/mockup/mobile",
    "packages/website/src/android-version.ts", "packages/website/src/android-version.test.ts",
    "packages/website/public/mobile-mockup.png", "packages/website/public/iphone-mockup-left.png",
    "packages/app/assets/images/android-icon-foreground.png", "packages/app/assets/images/splash-icon.png",
    "packages/app/scripts/reset-project.js",
]


def files(root):
    if root.is_file():
        return [root]
    result = []
    for directory, dirs, names in os.walk(root):
        dirs[:] = [name for name in dirs if name not in SKIP]
        result.extend(Path(directory) / name for name in names if not (Path(directory) / name).is_symlink())
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    remove = {p for item in REMOVE for p in files(ROOT / item)}
    sources = files(ROOT / "packages/app/src")
    remove.update(p for p in sources if re.search(r"\.(native|ios|android)\.", p.name))
    writes = {}
    for p in sources:
        if p in remove:
            continue
        match = re.fullmatch(r"(.+)\.web(\.[jt]sx?)", p.name)
        if match:
            destination = p.with_name(match[1] + match[2])
            writes[destination] = p.read_bytes()
            remove.add(p)
    promoted_paths = [(p.relative_to(ROOT).as_posix(), p.relative_to(ROOT).as_posix().replace(".web.", ".")) for p in remove if p.name.endswith((".web.ts", ".web.tsx"))]
    # Explicit .web imports in browser tests and bundler entries now use the base.
    for p in files(ROOT):
        if p in remove or p.suffix not in {".ts", ".tsx", ".js", ".mjs", ".cjs", ".json"}:
            continue
        original = writes.get(p, p.read_bytes())
        try:
            text = original.decode()
        except UnicodeDecodeError:
            continue
        after = re.sub(r"([\"'])((?:\.{1,2}/|@/)[^\"']*)\.web(?=(?:\.js)?[\"'])", r"\1\2", text)
        # Preserve resolved file paths in build/test configuration after promotion.
        for old_path, new_path in promoted_paths:
            after = after.replace(old_path, new_path)
        if after.encode() != original:
            writes[p] = after.encode()
    root_package = json.loads((ROOT / "package.json").read_text())
    root_package["workspaces"] = [p for p in root_package["workspaces"] if p != "packages/expo-two-way-audio"]
    for key in list(root_package["scripts"]):
        if re.search(r"android|ios|apk|fdroid|mobile", key):
            del root_package["scripts"][key]
        else:
            root_package["scripts"][key] = root_package["scripts"][key].replace(" && npm run build --workspace=@mixer/expo-two-way-audio", "").replace(" && npm run fdroid:changelogs", "")
    root_package["devDependencies"].pop("expo-module-scripts", None)
    writes[ROOT / "package.json"] = (json.dumps(root_package, indent=2) + "\n").encode()
    app_package = json.loads((ROOT / "packages/app/package.json").read_text())
    for key in list(app_package["scripts"]):
        if re.search(r"android|ios|apk|eas", key):
            del app_package["scripts"][key]
    for key in ["@mixer/expo-two-way-audio", "expo-build-properties", "expo-dev-client", "expo-gradle-jvmargs", "eas-cli", "serve-sim", "expo-camera", "expo-notifications", "expo-haptics", "expo-audio", "@mattermost/react-native-paste-input", "@shopify/react-native-skia", "react-native-nitro-modules", "expo-image-manipulator", "expo-sqlite", "react-native-webview", "expo-document-picker", "expo-file-system", "expo-sharing", "react-native-keyboard-controller", "expo-splash-screen", "expo-system-ui", "react-native-edge-to-edge"]:
        app_package["dependencies"].pop(key, None)
        app_package["devDependencies"].pop(key, None)
    app_package.pop("enriched-markdown", None)
    app_package.pop("reanimated", None)
    app_package["dependencies"].pop("qrcode", None)
    app_package["devDependencies"].pop("@types/qrcode", None)
    writes[ROOT / "packages/app/package.json"] = (json.dumps(app_package, indent=2) + "\n").encode()
    config = json.loads((ROOT / "mixer.json").read_text())
    config["scripts"].pop("ios-simulator", None)
    config["worktree"]["setup"] = [command for command in config["worktree"]["setup"] if "seed-ios" not in command and "expo-two-way-audio" not in command]
    writes[ROOT / "mixer.json"] = (json.dumps(config, indent=2) + "\n").encode()
    instructions_path = ROOT / "CLAUDE.md"
    instructions = instructions_path.read_text().replace("Mixer is a mobile app for monitoring and controlling your local AI coding agents from anywhere. Your dev environment, in your pocket.", "Mixer is a desktop IDE for monitoring and controlling your local AI coding agents.")
    instructions = instructions.replace("Mobile + web client (Expo)", "Electron renderer (Expo + React Native Web)")
    instructions = "\n".join(line for line in instructions.splitlines() if not any(f"docs/{name}" in line for name in ["android.md", "mobile-testing.md", "native-text-selection.md"])) + "\n"
    instructions = re.sub(r"When Mo requests an APK,.*?\n\n", "", instructions, flags=re.DOTALL)
    instructions = re.sub(r"## Platform gating\n.*?(?=## Debugging)", "## Desktop renderer\n\nMixer only targets Electron desktop. `packages/app` is its web renderer, not a mobile app.\nKeep Expo, React Native Web, Unistyles, and responsive compact-window layouts that the\ndesktop renderer uses. Do not add iOS/Android targets, native app modules, native-only\nimplementations, app-store tooling, or phone pairing UI. Prefer the base implementation\nfor web code and `.electron.ts` / `.electron.tsx` for Electron bridge integrations.\nUse `getIsElectron()` for bridge access and `useIsCompactFormFactor()` for narrow windows.\nThe daemon and CLI remain desktop host services. Never restart a running daemon without permission.\n\n", instructions, flags=re.DOTALL)
    writes[instructions_path] = instructions.encode()
    # npm can retain orphaned workspace metadata in its hidden install lock.
    for relative in ["package-lock.json", "node_modules/.package-lock.json"]:
        lock_path = ROOT / relative
        if not lock_path.exists():
            continue
        lock = json.loads(lock_path.read_text())
        entries = lock.get("packages", {})
        for key in list(entries):
            if key == "packages/expo-two-way-audio" or key.startswith("packages/expo-two-way-audio/"):
                del entries[key]
        writes[lock_path] = (json.dumps(lock, indent=2, ensure_ascii=False) + "\n").encode()
    print(f"Delete {len(remove)} source files; write/promote {len(writes)} files")
    if not args.apply:
        for p in sorted(remove):
            print("DELETE", p.relative_to(ROOT))
        for p in sorted(writes):
            print("WRITE", p.relative_to(ROOT))
        return
    backup = Path(tempfile.mkdtemp(prefix="mixer-desktop-only-")) / "originals.zip"
    with zipfile.ZipFile(backup, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("plan.json", json.dumps({"delete": [str(p.relative_to(ROOT)) for p in sorted(remove)], "write": [str(p.relative_to(ROOT)) for p in sorted(writes)]}, indent=2))
        for p in sorted(remove | writes.keys()):
            if p.exists():
                archive.write(p, p.relative_to(ROOT))
    for p, data in writes.items():
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
    for p in remove:
        p.unlink()
    for relative in REMOVE:
        target = ROOT / relative
        if target.is_dir():
            shutil.rmtree(target)
    print(f"Backup: {backup}")


if __name__ == "__main__":
    main()
