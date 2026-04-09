/**
 * Auto-Provision — Public API
 */

export { Provisioner } from "./provisioner.js";
export { detectManagers, checkInstalled, selectManager } from "./detector.js";
export { calculateTrust } from "./trust.js";
export { install, verify } from "./installer.js";

export type { ProvisionOptions, ProvisionResult, ProvisionStatus, ConfirmInfo } from "./provisioner.js";
export type { PackageManager, DetectedManager } from "./detector.js";
export type { TrustScore, TrustLevel } from "./trust.js";
export type { InstallResult } from "./installer.js";
