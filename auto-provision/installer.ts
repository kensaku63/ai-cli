/**
 * Auto-Provision — Install execution
 *
 * Executes package installs via execFile (no shell) for injection safety.
 * Package names are passed as arguments, never interpolated into strings.
 */

import { execFile } from "node:child_process";
import type { PackageManager } from "./detector.js";

export interface InstallResult {
  success: boolean;
  manager: PackageManager;
  packageName: string;
  output: string;
  error: string;
  exitCode: number;
}

/** Build the command and args for each package manager */
function buildInstallArgs(
  manager: PackageManager,
  packageName: string,
): { cmd: string; args: string[] } {
  switch (manager) {
    case "brew":
      return { cmd: "brew", args: ["install", packageName] };
    case "apt":
      return { cmd: "sudo", args: ["apt-get", "install", "-y", packageName] };
    case "npm":
      return { cmd: "npm", args: ["install", "-g", packageName] };
    case "pip":
      return { cmd: "pip", args: ["install", packageName] };
    case "cargo":
      return { cmd: "cargo", args: ["install", packageName] };
    case "choco":
      return { cmd: "choco", args: ["install", "-y", packageName] };
  }
}

/** Execute the install command */
export function install(
  manager: PackageManager,
  packageName: string,
  timeoutMs = 120_000,
): Promise<InstallResult> {
  const { cmd, args } = buildInstallArgs(manager, packageName);

  return new Promise((resolve) => {
    const proc = execFile(cmd, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      resolve({
        success: !err,
        manager,
        packageName,
        output: stdout?.toString() ?? "",
        error: stderr?.toString() ?? "",
        exitCode: err ? (err as NodeJS.ErrnoException & { code?: number }).code === "ETIMEDOUT" ? 124 : 1 : 0,
      });
    });
  });
}

/** Verify installation by running the tool's check command */
export function verify(checkCmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    const [cmd, ...args] = checkCmd.split(/\s+/);
    if (!cmd) { resolve(false); return; }
    execFile(cmd, args, { timeout: 10_000 }, (err) => {
      resolve(!err);
    });
  });
}
