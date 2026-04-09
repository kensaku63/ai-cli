/**
 * Auto-Provision — Main facade
 *
 * Pipeline: Check → Score → Confirm → Detect → Install → Verify
 */

import type { ToolMetadata } from "../tool-registry/schema.js";
import { detectManagers, checkInstalled, selectManager } from "./detector.js";
import { calculateTrust, type TrustScore } from "./trust.js";
import { install, verify } from "./installer.js";
import type { PackageManager } from "./detector.js";

export interface ProvisionOptions {
  /** Skip confirmation prompt (default: false) */
  autoApprove?: boolean;
  /** Confirmation callback — return true to proceed, false to cancel */
  confirm?: (info: ConfirmInfo) => Promise<boolean>;
  /** Install timeout in ms (default: 120_000) */
  timeout?: number;
}

export interface ConfirmInfo {
  tool: ToolMetadata;
  manager: PackageManager;
  packageName: string;
  trust: TrustScore;
}

export type ProvisionStatus =
  | "already_installed"
  | "installed"
  | "cancelled"
  | "no_manager"
  | "install_failed"
  | "verify_failed";

export interface ProvisionResult {
  status: ProvisionStatus;
  tool: { id: string; name: string };
  trust: TrustScore;
  manager?: PackageManager;
  packageName?: string;
  output?: string;
  error?: string;
}

export class Provisioner {
  /**
   * Provision a tool: check → score → confirm → detect → install → verify
   */
  async provision(
    tool: ToolMetadata,
    options: ProvisionOptions = {},
  ): Promise<ProvisionResult> {
    const trust = calculateTrust(tool);
    const base = { tool: { id: tool.id, name: tool.name }, trust };

    // 1. Check — is it already installed?
    if (tool.install.check) {
      const installed = await checkInstalled(tool.install.check);
      if (installed) {
        return { ...base, status: "already_installed" };
      }
    }

    // 2. Detect — find available package managers
    const managers = await detectManagers();

    // 3. Select — pick the best manager for this tool
    const selection = selectManager(tool.install, managers);
    if (!selection) {
      return { ...base, status: "no_manager" };
    }

    const { manager, packageName } = selection;

    // 4. Confirm — ask user (unless autoApprove)
    if (!options.autoApprove) {
      const confirmFn = options.confirm ?? defaultConfirm;
      const approved = await confirmFn({ tool, manager, packageName, trust });
      if (!approved) {
        return { ...base, status: "cancelled", manager, packageName };
      }
    }

    // 5. Install
    const timeoutMs = options.timeout ?? 120_000;
    const result = await install(manager, packageName, timeoutMs);

    if (!result.success) {
      return {
        ...base,
        status: "install_failed",
        manager,
        packageName,
        output: result.output,
        error: result.error,
      };
    }

    // 6. Verify — confirm the tool is now available
    if (tool.install.check) {
      const verified = await verify(tool.install.check);
      if (!verified) {
        return {
          ...base,
          status: "verify_failed",
          manager,
          packageName,
          output: result.output,
        };
      }
    }

    return {
      ...base,
      status: "installed",
      manager,
      packageName,
      output: result.output,
    };
  }
}

/** Default confirm: always approve (for programmatic use; CLI overrides this) */
async function defaultConfirm(_info: ConfirmInfo): Promise<boolean> {
  return true;
}
