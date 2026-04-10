/**
 * Tool Registry — Load and manage tool metadata
 */

import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolMetadata } from "./schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUILTIN_DIR = join(__dirname, "data", "builtin");
const AUTO_DIR = join(__dirname, "data", "auto");

export class Registry {
  private tools: Map<string, ToolMetadata> = new Map();

  /** Load all builtin tool metadata from data/builtin/ */
  async loadBuiltin(): Promise<void> {
    const entries = await readdir(BUILTIN_DIR);
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const raw = await readFile(join(BUILTIN_DIR, entry), "utf-8");
      const meta: ToolMetadata = JSON.parse(raw);
      this.tools.set(meta.id, meta);
    }
  }

  /**
   * Load auto-generated tool metadata from data/auto/*.jsonl.
   *
   * Conflict resolution: builtin entries always win. Auto entries are only
   * added for ids that are not already present. This matches the
   * "builtin優先" rule from the auto-knowledge design doc (PROJECT.md v2).
   *
   * Silently returns 0 if the directory does not exist (the auto pipeline
   * is optional — a fresh checkout without generated data still works).
   */
  async loadAuto(): Promise<number> {
    let entries: string[];
    try {
      entries = await readdir(AUTO_DIR);
    } catch {
      return 0;
    }

    let loaded = 0;
    for (const entry of entries) {
      if (!entry.endsWith(".jsonl")) continue;
      const raw = await readFile(join(AUTO_DIR, entry), "utf-8");
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let meta: ToolMetadata;
        try {
          meta = JSON.parse(trimmed) as ToolMetadata;
        } catch {
          continue;
        }
        if (!meta.id) continue;
        // builtin wins over auto
        if (this.tools.has(meta.id)) {
          const existing = this.tools.get(meta.id)!;
          if (existing.source === "builtin") continue;
        }
        this.tools.set(meta.id, meta);
        loaded++;
      }
    }
    return loaded;
  }

  /** Register a single tool (for dynamic/community additions) */
  register(tool: ToolMetadata): void {
    this.tools.set(tool.id, tool);
  }

  /** Get a tool by ID */
  get(id: string): ToolMetadata | undefined {
    return this.tools.get(id);
  }

  /** Get all registered tools */
  all(): ToolMetadata[] {
    return Array.from(this.tools.values());
  }

  /** Number of registered tools */
  get size(): number {
    return this.tools.size;
  }
}
