import { mkdtemp, open, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import {
  acquirePidLock,
  getPidLockInfo,
  isLocked,
  PidLockError,
  refreshPidLock,
  releasePidLock,
  updatePidLock,
} from "./pid-lock.js";

describe("pid-lock ownership", () => {
  test("writes and releases lock for explicit owner pid", async () => {
    const parent = await mkdtemp(join(tmpdir(), "mixer-pid-lock-owner-"));
    const mixerHome = join(parent, "home");
    const ownerPid = process.pid + 10_000;

    try {
      await (
        acquirePidLock as unknown as (
          home: string,
          sockPath: string | null,
          options: { ownerPid: number },
        ) => Promise<void>
      )(mixerHome, null, { ownerPid });

      if (process.platform !== "win32") {
        expect((await stat(mixerHome)).mode & 0o777).toBe(0o700);
      }
      const lock = await getPidLockInfo(mixerHome);
      expect(lock?.pid).toBe(ownerPid);
      expect(lock?.listen).toBeNull();
      expect(lock?.heartbeat).toBe(true);

      await (
        updatePidLock as unknown as (
          home: string,
          patch: { listen: string },
          options: { ownerPid: number },
        ) => Promise<void>
      )(mixerHome, { listen: "127.0.0.1:6767" }, { ownerPid });

      const updatedLock = await getPidLockInfo(mixerHome);
      expect(updatedLock?.listen).toBe("127.0.0.1:6767");

      await (
        releasePidLock as unknown as (home: string, options: { ownerPid: number }) => Promise<void>
      )(mixerHome, { ownerPid: ownerPid + 1 });
      const lockAfterWrongOwnerRelease = await getPidLockInfo(mixerHome);
      expect(lockAfterWrongOwnerRelease?.pid).toBe(ownerPid);

      await (
        releasePidLock as unknown as (home: string, options: { ownerPid: number }) => Promise<void>
      )(mixerHome, { ownerPid });
      const lockAfterOwnerRelease = await getPidLockInfo(mixerHome);
      expect(lockAfterOwnerRelease).toBeNull();
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  test("keeps a stale heartbeat lock when the recorded pid is alive without a reachability check", async () => {
    const mixerHome = await mkdtemp(join(tmpdir(), "mixer-pid-lock-stale-heartbeat-"));
    const replacementOwnerPid = process.pid + 10_000;

    try {
      const pidPath = join(mixerHome, "mixer.pid");
      await writeFile(
        pidPath,
        JSON.stringify({
          pid: process.pid,
          startedAt: new Date().toISOString(),
          hostname: "old-host",
          uid: process.getuid?.() ?? 0,
          listen: "127.0.0.1:6767",
          desktopManaged: true,
          heartbeat: true,
        }),
      );
      const staleTime = new Date(Date.now() - 10 * 60_000);
      await utimes(pidPath, staleTime, staleTime);

      await expect(isLocked(mixerHome)).resolves.toMatchObject({ locked: true });
      await expect(
        acquirePidLock(mixerHome, null, { ownerPid: replacementOwnerPid }),
      ).rejects.toThrow("Another Mixer daemon is already running");

      const lock = await getPidLockInfo(mixerHome);
      expect(lock?.pid).toBe(process.pid);
    } finally {
      await rm(mixerHome, { recursive: true, force: true });
    }
  });

  test("preserves a stale live desktop heartbeat lock", async () => {
    const mixerHome = await mkdtemp(join(tmpdir(), "mixer-pid-lock-stale-desktop-heartbeat-"));
    const replacementOwnerPid = process.pid + 10_000;

    try {
      const pidPath = join(mixerHome, "mixer.pid");
      await writeFile(
        pidPath,
        JSON.stringify({
          pid: process.pid,
          startedAt: new Date().toISOString(),
          hostname: "old-host",
          uid: process.getuid?.() ?? 0,
          listen: "127.0.0.1:6767",
          desktopManaged: true,
          heartbeat: true,
        }),
      );
      const staleTime = new Date(Date.now() - 10 * 60_000);
      await utimes(pidPath, staleTime, staleTime);

      await expect(
        acquirePidLock(mixerHome, null, { ownerPid: replacementOwnerPid }),
      ).rejects.toThrow("Another Mixer daemon is already running");

      const lock = await getPidLockInfo(mixerHome);
      expect(lock?.pid).toBe(process.pid);
      expect(lock?.listen).toBe("127.0.0.1:6767");
    } finally {
      await rm(mixerHome, { recursive: true, force: true });
    }
  });

  test("keeps a stale live lock written by a pre-heartbeat daemon", async () => {
    const mixerHome = await mkdtemp(join(tmpdir(), "mixer-pid-lock-legacy-live-"));
    const pidPath = join(mixerHome, "mixer.pid");

    try {
      await writeFile(
        pidPath,
        JSON.stringify({
          pid: process.pid,
          startedAt: new Date().toISOString(),
          hostname: "old-host",
          uid: process.getuid?.() ?? 0,
          listen: "127.0.0.1:6767",
          desktopManaged: true,
        }),
      );
      const staleTime = new Date(Date.now() - 10 * 60_000);
      await utimes(pidPath, staleTime, staleTime);

      await expect(
        acquirePidLock(mixerHome, null, { ownerPid: process.pid + 10_000 }),
      ).rejects.toThrow("Another Mixer daemon is already running");

      const lock = await getPidLockInfo(mixerHome);
      expect(lock?.pid).toBe(process.pid);
    } finally {
      await rm(mixerHome, { recursive: true, force: true });
    }
  });

  test("preserves a stale live legacy desktop lock", async () => {
    const mixerHome = await mkdtemp(join(tmpdir(), "mixer-pid-lock-legacy-desktop-"));
    const replacementOwnerPid = process.pid + 10_000;
    const pidPath = join(mixerHome, "mixer.pid");

    try {
      await writeFile(
        pidPath,
        JSON.stringify({
          pid: process.pid,
          startedAt: new Date().toISOString(),
          hostname: "old-host",
          uid: process.getuid?.() ?? 0,
          listen: "127.0.0.1:6767",
          desktopManaged: true,
        }),
      );
      const staleTime = new Date(Date.now() - 10 * 60_000);
      await utimes(pidPath, staleTime, staleTime);

      await expect(
        acquirePidLock(mixerHome, null, { ownerPid: replacementOwnerPid }),
      ).rejects.toThrow("Another Mixer daemon is already running");

      const lock = await getPidLockInfo(mixerHome);
      expect(lock?.pid).toBe(process.pid);
      expect(lock?.heartbeat).toBeUndefined();
    } finally {
      await rm(mixerHome, { recursive: true, force: true });
    }
  });

  test("rejects a heartbeat refresh after another supervisor takes ownership", async () => {
    const mixerHome = await mkdtemp(join(tmpdir(), "mixer-pid-lock-refresh-owner-"));

    try {
      await acquirePidLock(mixerHome, null, { ownerPid: process.pid + 10_000 });

      await expect(refreshPidLock(mixerHome, { ownerPid: process.pid })).rejects.toBeInstanceOf(
        PidLockError,
      );
    } finally {
      await rm(mixerHome, { recursive: true, force: true });
    }
  });

  test("retries a heartbeat refresh while its owner is rewriting the lock", async () => {
    const mixerHome = await mkdtemp(join(tmpdir(), "mixer-pid-lock-refresh-rewrite-"));
    const pidPath = join(mixerHome, "mixer.pid");

    try {
      await acquirePidLock(mixerHome, null, { ownerPid: process.pid });
      const lock = await getPidLockInfo(mixerHome);
      expect(lock).not.toBeNull();

      const rewriteHandle = await open(pidPath, "r+");
      await rewriteHandle.truncate(0);

      const refresh = refreshPidLock(mixerHome, { ownerPid: process.pid });
      await new Promise((resolve) => setTimeout(resolve, 250));
      await rewriteHandle.writeFile(JSON.stringify(lock));
      await rewriteHandle.close();

      await expect(refresh).resolves.toBeUndefined();
    } finally {
      await rm(mixerHome, { recursive: true, force: true });
    }
  });

  test("keeps a fresh lock when the recorded pid is alive", async () => {
    const mixerHome = await mkdtemp(join(tmpdir(), "mixer-pid-lock-fresh-heartbeat-"));

    try {
      await writeFile(
        join(mixerHome, "mixer.pid"),
        JSON.stringify({
          pid: process.pid,
          startedAt: new Date().toISOString(),
          hostname: "current-host",
          uid: process.getuid?.() ?? 0,
          listen: "127.0.0.1:6767",
          desktopManaged: true,
          heartbeat: true,
        }),
      );

      await expect(
        acquirePidLock(mixerHome, null, { ownerPid: process.pid + 10_000 }),
      ).rejects.toThrow("Another Mixer daemon is already running");

      const lock = await getPidLockInfo(mixerHome);
      expect(lock?.pid).toBe(process.pid);
      expect(lock?.listen).toBe("127.0.0.1:6767");
    } finally {
      await rm(mixerHome, { recursive: true, force: true });
    }
  });

  test("starts over an empty lock file left by a supervisor killed before writing it", async () => {
    const mixerHome = await mkdtemp(join(tmpdir(), "mixer-pid-lock-empty-"));
    const ownerPid = process.pid + 10_000;

    try {
      await writeFile(join(mixerHome, "mixer.pid"), "");

      await expect(getPidLockInfo(mixerHome)).resolves.toBeNull();
      await acquirePidLock(mixerHome, null, { ownerPid });

      const lock = await getPidLockInfo(mixerHome);
      expect(lock?.pid).toBe(ownerPid);
    } finally {
      await rm(mixerHome, { recursive: true, force: true });
    }
  });

  test("keeps a lock file whose contents cannot be read as a lock", async () => {
    const mixerHome = await mkdtemp(join(tmpdir(), "mixer-pid-lock-unparseable-"));
    const pidPath = join(mixerHome, "mixer.pid");

    try {
      await writeFile(pidPath, JSON.stringify({ pid: "unknown" }));

      await expect(
        acquirePidLock(mixerHome, null, { ownerPid: process.pid + 10_000 }),
      ).rejects.toThrow("Cannot read daemon state");

      await expect(readFile(pidPath, "utf-8")).resolves.toBe(JSON.stringify({ pid: "unknown" }));
    } finally {
      await rm(mixerHome, { recursive: true, force: true });
    }
  });
});
