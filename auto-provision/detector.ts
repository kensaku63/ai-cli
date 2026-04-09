/**
 * Auto-Provision — Package manager detection
 *
 * Detects which package managers are available on the current system.
 */

import { execFile } from "node:child_process";

export type PackageManager = "brew" | "apt" | "npm" | "pip" | "cargo" | "choco";

export interface DetectedManager {
  name: PackageManager;
  path: string;
  version: string;
}

/** Check if a command exists and get its version */
function checkCommand(
  cmd: string,
  versionArgs: string[],
): Promise<{ path: string; version: string } | null> {
  return new Promise((resolve) => {
    execFile("which", [cmd], (err, stdout) => {
      if (err || !stdout.trim()) {
        resolve(null);
        return;
      }
      const path = stdout.trim();
      execFile(cmd, versionArgs, (verr, vstdout, vstderr) => {
        const version = (vstdout || vstderr || "").trim().split("\n")[0] ?? "";
        resolve({ path, version });
      });
    });
  });
}

const MANAGER_CHECKS: Record<PackageManager, { versionArgs: string[] }> = {
  brew:  { versionArgs: ["--version"] },
  apt:   { versionArgs: ["--version"] },
  npm:   { versionArgs: ["--version"] },
  pip:   { versionArgs: ["--version"] },
  cargo: { versionArgs: ["--version"] },
  choco: { versionArgs: ["--version"] },
};

/** Detect all available package managers on the system */
export async function detectManagers(): Promise<DetectedManager[]> {
  const results = await Promise.all(
    Object.entries(MANAGER_CHECKS).map(async ([name, { versionArgs }]) => {
      const result = await checkCommand(name, versionArgs);
      if (!result) return null;
      return { name: name as PackageManager, ...result };
    }),
  );
  return results.filter((r): r is DetectedManager => r !== null);
}

/** Check if a specific tool is installed by running its check command */
export function checkInstalled(checkCmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    const [cmd, ...args] = checkCmd.split(/\s+/);
    if (!cmd) { resolve(false); return; }
    execFile(cmd, args, (err) => {
      resolve(!err);
    });
  });
}

/**
 * Select the best package manager for a tool based on:
 * 1. What install methods the tool supports
 * 2. What managers are available on the system
 *
 * Priority: brew > apt > npm > pip > cargo > choco
 */
export function selectManager(
  toolInstall: Record<string, string | undefined>,
  available: DetectedManager[],
): { manager: PackageManager; packageName: string } | null {
  const priority: PackageManager[] = ["brew", "apt", "npm", "pip", "cargo", "choco"];
  const availableNames = new Set(available.map((m) => m.name));

  for (const mgr of priority) {
    const pkg = toolInstall[mgr];
    if (pkg && availableNames.has(mgr)) {
      return { manager: mgr, packageName: pkg };
    }
  }
  return null;
}
