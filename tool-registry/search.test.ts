import { describe, test, expect, beforeAll } from "bun:test";
import { Registry } from "./registry";
import { searchTools } from "./search";
import type { ToolMetadata } from "./schema";

let tools: ToolMetadata[];

beforeAll(async () => {
  const registry = new Registry();
  await registry.loadBuiltin();
  tools = registry.all();
});

describe("Registry", () => {
  test("loads all 20 builtin tools", () => {
    expect(tools.length).toBe(20);
  });

  test("each tool has required fields", () => {
    for (const tool of tools) {
      expect(tool.id).toBeTruthy();
      expect(tool.name).toBeTruthy();
      expect(tool.type).toBe("cli");
      expect(tool.description).toBeTruthy();
      expect(tool.intents.length).toBeGreaterThan(0);
    }
  });
});

describe("Search — exact tool name", () => {
  test("query 'git' returns git as top result", () => {
    const results = searchTools("git", tools);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].tool.id).toBe("git");
  });

  test("query 'docker' returns docker as top result", () => {
    const results = searchTools("docker", tools);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].tool.id).toBe("docker");
  });

  test("query 'kubectl' returns kubectl as top result", () => {
    const results = searchTools("kubectl", tools);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].tool.id).toBe("kubectl");
  });
});

describe("Search — natural language (English)", () => {
  test("'clone a repository' finds git", () => {
    const results = searchTools("clone a repository", tools);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].tool.id).toBe("git");
  });

  test("'run a container' finds docker", () => {
    const results = searchTools("run a container", tools);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].tool.id).toBe("docker");
  });

  test("'parse JSON' finds jq", () => {
    const results = searchTools("parse JSON", tools);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].tool.id).toBe("jq");
  });

  test("'search text in files' finds ripgrep", () => {
    const results = searchTools("search text in files", tools);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].tool.id).toBe("ripgrep");
  });

  test("'send HTTP request' finds curl", () => {
    const results = searchTools("send HTTP request", tools);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].tool.id).toBe("curl");
  });

  test("'install npm package' finds npm", () => {
    const results = searchTools("install npm package", tools);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].tool.id).toBe("npm");
  });

  test("'deploy to kubernetes' finds kubectl", () => {
    const results = searchTools("deploy to kubernetes", tools);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].tool.id).toBe("kubectl");
  });

  test("'upload to S3' finds aws", () => {
    const results = searchTools("upload to S3", tools);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].tool.id).toBe("aws");
  });

  test("'find and replace text' finds sed", () => {
    const results = searchTools("find and replace text", tools);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].tool.id).toBe("sed");
  });

  test("'compress directory' finds tar", () => {
    const results = searchTools("compress directory", tools);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].tool.id).toBe("tar");
  });
});

describe("Search — natural language (Japanese)", () => {
  test("'リポジトリをクローンしたい' finds git", () => {
    const results = searchTools("リポジトリをクローンしたい", tools);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].tool.id).toBe("git");
  });

  test("'コンテナを起動したい' finds docker", () => {
    const results = searchTools("コンテナを起動したい", tools);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].tool.id).toBe("docker");
  });

  test("'JSONをパースしたい' finds jq", () => {
    const results = searchTools("JSONをパースしたい", tools);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].tool.id).toBe("jq");
  });

  test("'ファイルを同期したい' finds rsync", () => {
    const results = searchTools("ファイルを同期したい", tools);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].tool.id).toBe("rsync");
  });

  test("'APIにリクエストを送りたい' finds curl", () => {
    const results = searchTools("APIにリクエストを送りたい", tools);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].tool.id).toBe("curl");
  });
});

describe("Search — options", () => {
  test("limit controls max results", () => {
    const results = searchTools("file", tools, { limit: 3 });
    expect(results.length).toBeLessThanOrEqual(3);
  });

  test("higher threshold returns fewer results", () => {
    const loose = searchTools("file", tools, { threshold: 0.1 });
    const strict = searchTools("file", tools, { threshold: 5 });
    expect(strict.length).toBeLessThanOrEqual(loose.length);
  });

  test("results are sorted by score descending", () => {
    const results = searchTools("search files", tools);
    for (let i = 1; i < results.length; i++) {
      expect(results[i].score).toBeLessThanOrEqual(results[i - 1].score);
    }
  });

  test("each result has matchedOn populated", () => {
    const results = searchTools("git commit", tools);
    for (const r of results) {
      expect(r.matchedOn.length).toBeGreaterThan(0);
    }
  });
});
