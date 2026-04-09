/**
 * Tool Registry — Load and manage tool metadata
 */

import { join } from "node:path";
import type { ToolMetadata } from "./schema";

const BUILTIN_DIR = join(import.meta.dir, "data", "builtin");

export class Registry {
  private tools: Map<string, ToolMetadata> = new Map();

  /** Load all builtin tool metadata from data/builtin/ */
  async loadBuiltin(): Promise<void> {
    const glob = new Bun.Glob("*.json");
    for await (const path of glob.scan(BUILTIN_DIR)) {
      const file = Bun.file(join(BUILTIN_DIR, path));
      const meta: ToolMetadata = await file.json();
      this.tools.set(meta.id, meta);
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
