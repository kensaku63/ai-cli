/**
 * Tool Registry — Load and manage tool metadata
 */

import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolMetadata } from "./schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUILTIN_DIR = join(__dirname, "data", "builtin");
const AUTO_JSONL = join(__dirname, "data", "auto", "tools.jsonl");

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

  /** Load auto-generated tool metadata from data/auto/tools.jsonl */
  async loadAuto(): Promise<void> {
    try {
      const content = await readFile(AUTO_JSONL, "utf-8");
      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        const meta: ToolMetadata = JSON.parse(line);
        // Builtin takes priority — don't overwrite
        if (!this.tools.has(meta.id)) {
          this.tools.set(meta.id, meta);
        }
      }
    } catch {
      // auto/tools.jsonl doesn't exist yet — that's fine
    }
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
