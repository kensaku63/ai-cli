/**
 * Tool Registry — Public API
 */

export { Registry } from "./registry.js";
export { searchTools, SearchEngine } from "./search.js";
export { EmbeddingIndex, cosineSimilarity } from "./embeddings.js";
export type {
  ToolMetadata,
  ToolType,
  InstallInfo,
  Subcommand,
  SearchResult,
} from "./schema.js";
export type { SearchOptions } from "./search.js";
