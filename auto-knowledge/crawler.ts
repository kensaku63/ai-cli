/**
 * Auto-Knowledge Crawler — Fetch CLI package metadata from npm registry.
 *
 * Strategy:
 * 1. Search API (keywords:cli, popularity-sorted) → package name list
 * 2. GET /{package}/latest → check bin field → CrawlResult
 */

export interface CrawlResult {
  name: string;
  description: string;
  version: string;
  keywords: string[];
  readme: string;
  bin: Record<string, string>;
  repository?: string;
  homepage?: string;
  downloads: number;
  dependencies: string[];
}

interface NpmSearchPackage {
  name: string;
  description?: string;
  keywords?: string[];
  links?: { repository?: string; homepage?: string; npm?: string };
}

interface NpmSearchObject {
  package: NpmSearchPackage;
  downloads?: { monthly?: number };
}

interface NpmSearchResponse {
  objects: NpmSearchObject[];
  total: number;
}

interface NpmPackageLatest {
  name: string;
  version?: string;
  description?: string;
  keywords?: string[];
  bin?: Record<string, string> | string;
  repository?: { type?: string; url?: string } | string;
  homepage?: string;
  dependencies?: Record<string, string>;
}

const NPM_REGISTRY = "https://registry.npmjs.org";
const NPM_SEARCH = `${NPM_REGISTRY}/-/v1/search`;
const NPM_DOWNLOADS = "https://api.npmjs.org/downloads/point/last-month";

/** Fetch with retry and self-throttle */
async function fetchJson<T>(url: string, retries = 3): Promise<T> {
  for (let i = 0; i < retries; i++) {
    const res = await fetch(url);
    if (res.status === 429) {
      const wait = Math.pow(2, i) * 1000;
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} for ${url}`);
    }
    return (await res.json()) as T;
  }
  throw new Error(`Failed after ${retries} retries: ${url}`);
}

/** Sleep for rate-limiting */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Search npm for CLI packages, sorted by popularity.
 * Returns package names (up to `limit`).
 */
export async function searchCliPackages(
  limit: number,
  onProgress?: (fetched: number, total: number) => void,
): Promise<string[]> {
  const names: string[] = [];
  const pageSize = 250; // npm max
  let from = 0;

  while (names.length < limit && from < 10_000) {
    const size = Math.min(pageSize, limit - names.length);
    const url = `${NPM_SEARCH}?text=keywords:cli&size=${size}&from=${from}&quality=0.0&popularity=1.0&maintenance=0.0`;
    const data = await fetchJson<NpmSearchResponse>(url);

    if (data.objects.length === 0) break;

    for (const obj of data.objects) {
      names.push(obj.package.name);
    }

    onProgress?.(names.length, data.total);
    from += data.objects.length;

    // Self-throttle: 200ms between search requests
    await sleep(200);
  }

  return names.slice(0, limit);
}

/** Normalize bin field (can be string or object) */
function normalizeBin(
  name: string,
  bin: Record<string, string> | string | undefined,
): Record<string, string> {
  if (!bin) return {};
  if (typeof bin === "string") return { [name]: bin };
  return bin;
}

/** Normalize repository field */
function normalizeRepo(
  repo: { type?: string; url?: string } | string | undefined,
): string | undefined {
  if (!repo) return undefined;
  if (typeof repo === "string") return repo;
  return repo.url?.replace(/^git\+/, "").replace(/\.git$/, "");
}

/**
 * Fetch full metadata for a single package.
 * Returns null if the package has no bin field (not a CLI tool).
 */
export async function fetchPackageMetadata(
  name: string,
): Promise<CrawlResult | null> {
  // Fetch latest version metadata (~7KB)
  const pkg = await fetchJson<NpmPackageLatest>(
    `${NPM_REGISTRY}/${encodeURIComponent(name)}/latest`,
  );

  const bin = normalizeBin(name, pkg.bin);
  if (Object.keys(bin).length === 0) return null; // Not a CLI tool

  // Fetch download count
  let downloads = 0;
  try {
    const dl = await fetchJson<{ downloads?: number }>(
      `${NPM_DOWNLOADS}/${encodeURIComponent(name)}`,
    );
    downloads = dl.downloads ?? 0;
  } catch {
    // Download API failures are non-critical
  }

  // Fetch readme from full packument only if needed for L2+
  // For L1, description + keywords are sufficient
  let readme = "";

  return {
    name,
    description: pkg.description ?? "",
    version: pkg.version ?? "0.0.0",
    keywords: pkg.keywords ?? [],
    readme,
    bin,
    repository: normalizeRepo(pkg.repository),
    homepage: pkg.homepage,
    downloads,
    dependencies: Object.keys(pkg.dependencies ?? {}),
  };
}

/**
 * Fetch README for L2+ knowledge extraction.
 * Uses the full packument (large response) to get readme field.
 */
export async function fetchReadme(name: string): Promise<string> {
  const url = `${NPM_REGISTRY}/${encodeURIComponent(name)}`;
  const res = await fetch(url);
  if (!res.ok) return "";

  const data = (await res.json()) as { readme?: string };
  const readme = data.readme ?? "";

  // Truncate to 4000 chars for LLM context efficiency
  return readme.slice(0, 4000);
}

export interface CrawlOptions {
  /** Number of packages to search (default: 100) */
  limit?: number;
  /** Delay between individual package fetches in ms (default: 100) */
  fetchDelay?: number;
  /** Progress callback */
  onProgress?: (stage: string, current: number, total: number) => void;
}

/**
 * Main crawl pipeline: search → fetch → filter (bin) → CrawlResult[]
 */
export async function crawl(options: CrawlOptions = {}): Promise<CrawlResult[]> {
  const { limit = 100, fetchDelay = 100, onProgress } = options;

  // Step 1: Search for CLI package names
  // ~10% of packages tagged "cli" actually have a bin field,
  // so search 12x the target to ensure enough CLI tools
  onProgress?.("search", 0, limit);
  const names = await searchCliPackages(limit * 12, (fetched, total) => {
    onProgress?.("search", fetched, total);
  });

  // Step 2: Fetch metadata and filter by bin field
  const results: CrawlResult[] = [];
  let fetched = 0;

  for (const name of names) {
    if (results.length >= limit) break;

    try {
      const result = await fetchPackageMetadata(name);
      if (result) {
        results.push(result);
      }
    } catch (err) {
      // Skip packages that fail to fetch
      const msg = err instanceof Error ? err.message : String(err);
      onProgress?.("error", fetched, names.length);
      console.error(`Skipping ${name}: ${msg}`);
    }

    fetched++;
    onProgress?.("fetch", fetched, names.length);

    // Rate limit
    await sleep(fetchDelay);
  }

  // Sort by downloads (most popular first)
  results.sort((a, b) => b.downloads - a.downloads);

  return results;
}
