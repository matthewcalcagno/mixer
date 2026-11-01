#!/usr/bin/env python3
"""Rename source identities; --apply saves originals before making changes.

HTTP links and license attribution retain their upstream identity. Generated output,
installed dependencies, and runtime state are never inputs. Rerunning is safe.
"""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parent.parent
SKIP = {"node_modules", ".dev", ".tmp", "dist", "build", "release", "test-results", "playwright-report", ".expo", ".debug", ".tasks", "conversations", "vendor"}
SELF = Path(__file__).relative_to(ROOT).as_posix()
WORDS = re.compile(r"getpaseo|GETPASEO|PASEO|Paseo|paseo")
REPLACEMENTS = {"getpaseo": "mixer", "GETPASEO": "MIXER", "PASEO": "MIXER", "Paseo": "Mixer", "paseo": "mixer"}
EXTERNAL = re.compile(r"(?:https?|wss?)://[^\s<>\"'`\\)]+|git@github\.com:[^\s\"']+")
WIRE_IDENTITIES = (
    "application/paseo-forge-change-request", "application/paseo-forge-issue",
    "application/paseo-review", "paseo_worktree_list_request",
    "paseo_worktree_archive_request", "create_paseo_worktree_request",
    "paseo_worktree_list_response", "paseo_worktree_archive_response",
    "create_paseo_worktree_response",
    "paseo-relay-e2ee/1", "x-paseo-daemon-id", "x-paseo-session-protocol",
    "paseo.prompt", "paseo.context", "paseo.inputs", "paseo.execution", "paseo.connections",
)


def rename(value):
    return WORDS.sub(lambda match: REPLACEMENTS[match[0]], value)


def convert(text, relative=""):
    protected = []
    def protect(match):
        protected.append(match[0])
        return f"__UPSTREAM_IDENTITY_{len(protected) - 1}__"
    text = re.sub(r"^.*(?:[Cc]opyright|SPDX-License-Identifier).*$", protect, text, flags=re.MULTILINE)
    text = re.sub(r"paseo(?:\\\.|\.)sh|getpaseo\.github\.io|getpaseo\.dev|@getpaseo/hub|ghcr\.io/getpaseo/hub|getpaseo/(?:paseo|hub)", protect, text)
    if relative.startswith("public-docs/hub/self-hosting/"):
        text = re.sub(r"PASEO_HUB_[A-Z_]+", protect, text)
    if "hub/" in relative:
        # Hub resource paths and its template language belong to the upstream service.
        text = re.sub(r"\.paseo/(?:hub\.(?:yml|toml)|workflows|triggers)|(?<=[\"'])\.paseo(?=[\"'])", protect, text)
    # Existing wire discriminants must remain readable by older clients/hosts.
    for index, value in enumerate(WIRE_IDENTITIES):
        text = text.replace(value, f"__WIRE_IDENTITY_{index}__")
    parts = []
    cursor = 0
    for match in EXTERNAL.finditer(text):
        parts.append(rename(text[cursor:match.start()]))
        parts.append(re.sub(r"\$\{[^}]+\}", lambda value: rename(value[0]), match[0]))
        cursor = match.end()
    parts.append(rename(text[cursor:]))
    result = "".join(parts)
    for index, value in enumerate(WIRE_IDENTITIES):
        result = result.replace(f"__WIRE_IDENTITY_{index}__", value)
    for index, value in enumerate(protected):
        result = result.replace(f"__UPSTREAM_IDENTITY_{index}__", value)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    listed = subprocess.check_output(["rg", "--files", "--hidden", "-0"], cwd=ROOT).split(b"\0")
    changes = []
    for raw in listed:
        if not raw:
            continue
        relative = Path(os.fsdecode(raw))
        if any(part in SKIP for part in relative.parts) or relative.as_posix() == SELF:
            continue
        if relative.parts[:3] in (("packages", "app", "ios"), ("packages", "app", "android")):
            continue
        path = ROOT / relative
        if path.is_symlink() or path.suffix in {".tsbuildinfo", ".map"}:
            continue
        before = path.read_bytes()
        try:
            text = before.decode("utf-8")
        except UnicodeDecodeError:
            text = None
        destination = Path(rename(relative.as_posix()))
        after = convert(text, relative.as_posix()).encode() if text is not None and "LICENSE" not in path.name.upper() else before
        if path.name == "package.json" and text is not None:
            data = json.loads(after)
            if str(data.get("name", "")).startswith("@mixer/") or relative.as_posix() == "package.json":
                data["private"] = True
                data.pop("publishConfig", None)
                after = (json.dumps(data, indent=2, ensure_ascii=False) + "\n").encode()
        if after != before or destination != relative:
            if destination != relative and (ROOT / destination).exists():
                raise RuntimeError(f"Destination exists: {destination}")
            changes.append((relative, destination, before, after, path.stat().st_mode))
    print(f"{len(changes)} files to update; {sum(old != new for old, new, *_ in changes)} paths to rename")
    if not args.apply:
        for old, new, *_ in changes:
            print(f"{old}" + (f" -> {new}" if old != new else ""))
        return
    backup = Path(tempfile.mkdtemp(prefix="mixer-rename-", dir=os.environ.get("TMPDIR"))) / "originals.zip"
    with zipfile.ZipFile(backup, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("rename-manifest.json", json.dumps([{ "old": str(old), "new": str(new) } for old, new, *_ in changes], indent=2))
        for old, _, before, _, _ in changes:
            archive.writestr(str(old), before)
    for old, new, _, after, mode in changes:
        target = ROOT / new
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(after)
        target.chmod(mode)
        if old != new:
            (ROOT / old).unlink()
    # Remove only empty source directories left by path renames.
    parents = {parent for old, new, *_ in changes if old != new for parent in (ROOT / old).parents if parent != ROOT and ROOT in parent.parents}
    for path in sorted(parents, key=lambda value: len(value.parts), reverse=True):
        if "paseo" in path.name.lower() or not any(path.iterdir()):
            try:
                path.rmdir()
            except OSError:
                pass
    print(f"Backup: {backup}")


if __name__ == "__main__":
    main()
