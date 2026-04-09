import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { Registry } from "./registry.js";
import { searchTools } from "./search.js";
import type { ToolMetadata } from "./schema.js";

let tools: ToolMetadata[];

before(async () => {
  const registry = new Registry();
  await registry.loadBuiltin();
  tools = registry.all();
});

describe("Registry", () => {
  it("loads all 50 builtin tools", () => {
    assert.equal(tools.length, 50);
  });

  it("each tool has required fields", () => {
    for (const tool of tools) {
      assert.ok(tool.id);
      assert.ok(tool.name);
      assert.equal(tool.type, "cli");
      assert.ok(tool.description);
      assert.ok(tool.intents.length > 0);
    }
  });
});

describe("Search — exact tool name", () => {
  it("query 'git' returns git as top result", () => {
    const results = searchTools("git", tools);
    assert.ok(results.length > 0);
    assert.equal(results[0]!.tool.id, "git");
  });

  it("query 'docker' returns docker as top result", () => {
    const results = searchTools("docker", tools);
    assert.ok(results.length > 0);
    assert.equal(results[0]!.tool.id, "docker");
  });

  it("query 'kubectl' returns kubectl as top result", () => {
    const results = searchTools("kubectl", tools);
    assert.ok(results.length > 0);
    assert.equal(results[0]!.tool.id, "kubectl");
  });
});

describe("Search — natural language (English)", () => {
  it("'clone a repository' finds git", () => {
    const results = searchTools("clone a repository", tools);
    assert.ok(results.length > 0);
    assert.equal(results[0]!.tool.id, "git");
  });

  it("'run a container' finds docker", () => {
    const results = searchTools("run a container", tools);
    assert.ok(results.length > 0);
    assert.equal(results[0]!.tool.id, "docker");
  });

  it("'parse JSON' finds jq", () => {
    const results = searchTools("parse JSON", tools);
    assert.ok(results.length > 0);
    assert.equal(results[0]!.tool.id, "jq");
  });

  it("'search text in files' finds ripgrep", () => {
    const results = searchTools("search text in files", tools);
    assert.ok(results.length > 0);
    assert.equal(results[0]!.tool.id, "ripgrep");
  });

  it("'send HTTP request' finds curl", () => {
    const results = searchTools("send HTTP request", tools);
    assert.ok(results.length > 0);
    assert.equal(results[0]!.tool.id, "curl");
  });

  it("'install npm package' finds npm", () => {
    const results = searchTools("install npm package", tools);
    assert.ok(results.length > 0);
    assert.equal(results[0]!.tool.id, "npm");
  });

  it("'deploy to kubernetes' finds kubectl", () => {
    const results = searchTools("deploy to kubernetes", tools);
    assert.ok(results.length > 0);
    assert.equal(results[0]!.tool.id, "kubectl");
  });

  it("'upload to S3' finds aws", () => {
    const results = searchTools("upload to S3", tools);
    assert.ok(results.length > 0);
    assert.equal(results[0]!.tool.id, "aws");
  });

  it("'find and replace text' finds sed", () => {
    const results = searchTools("find and replace text", tools);
    assert.ok(results.length > 0);
    assert.equal(results[0]!.tool.id, "sed");
  });

  it("'compress directory' finds tar", () => {
    const results = searchTools("compress directory", tools);
    assert.ok(results.length > 0);
    assert.equal(results[0]!.tool.id, "tar");
  });
});

describe("Search — natural language (Japanese)", () => {
  it("'リポジトリをクローンしたい' finds git", () => {
    const results = searchTools("リポジトリをクローンしたい", tools);
    assert.ok(results.length > 0);
    assert.equal(results[0]!.tool.id, "git");
  });

  it("'コンテナを起動したい' finds docker", () => {
    const results = searchTools("コンテナを起動したい", tools);
    assert.ok(results.length > 0);
    assert.equal(results[0]!.tool.id, "docker");
  });

  it("'JSONをパースしたい' finds jq", () => {
    const results = searchTools("JSONをパースしたい", tools);
    assert.ok(results.length > 0);
    assert.equal(results[0]!.tool.id, "jq");
  });

  it("'ファイルを同期したい' finds rsync", () => {
    const results = searchTools("ファイルを同期したい", tools);
    assert.ok(results.length > 0);
    assert.equal(results[0]!.tool.id, "rsync");
  });

  it("'APIにリクエストを送りたい' finds curl", () => {
    const results = searchTools("APIにリクエストを送りたい", tools);
    assert.ok(results.length > 0);
    assert.equal(results[0]!.tool.id, "curl");
  });
});

describe("Search — new tools (English)", () => {
  it("'create pull request' finds gh", () => {
    const results = searchTools("create pull request", tools);
    assert.ok(results.length > 0);
    assert.equal(results[0]!.tool.id, "gh");
  });

  it("'build project with make' finds make", () => {
    const results = searchTools("build project with make", tools);
    assert.ok(results.length > 0);
    assert.equal(results[0]!.tool.id, "make");
  });

  it("'run python script' finds python", () => {
    const results = searchTools("run python script", tools);
    assert.ok(results.length > 0);
    assert.equal(results[0]!.tool.id, "python");
  });

  it("'download file from URL' finds wget", () => {
    const results = searchTools("download file from URL", tools);
    assert.ok(results.length > 0);
    assert.equal(results[0]!.tool.id, "wget");
  });

  it("'check disk space' finds df", () => {
    const results = searchTools("check disk space", tools);
    assert.ok(results.length > 0);
    assert.equal(results[0]!.tool.id, "df");
  });

  it("'scan network ports' finds nmap", () => {
    const results = searchTools("scan network ports", tools);
    assert.ok(results.length > 0);
    assert.equal(results[0]!.tool.id, "nmap");
  });

  it("'compare two files' finds diff", () => {
    const results = searchTools("compare two files", tools);
    assert.ok(results.length > 0);
    assert.equal(results[0]!.tool.id, "diff");
  });

  it("'kill a process' finds kill", () => {
    const results = searchTools("kill a process", tools);
    assert.ok(results.length > 0);
    assert.equal(results[0]!.tool.id, "kill");
  });

  it("'DNS lookup' finds dig", () => {
    const results = searchTools("DNS lookup", tools);
    assert.ok(results.length > 0);
    assert.equal(results[0]!.tool.id, "dig");
  });

  it("'count lines in file' finds wc", () => {
    const results = searchTools("count lines in file", tools);
    assert.ok(results.length > 0);
    assert.equal(results[0]!.tool.id, "wc");
  });
});

describe("Search — new tools (Japanese)", () => {
  it("'PRを作成したい' finds gh", () => {
    const results = searchTools("PRを作成したい", tools);
    assert.ok(results.length > 0);
    assert.equal(results[0]!.tool.id, "gh");
  });

  it("'ディスク容量を確認したい' finds df", () => {
    const results = searchTools("ディスク容量を確認したい", tools);
    assert.ok(results.length > 0);
    assert.equal(results[0]!.tool.id, "df");
  });

  it("'プロセスを終了したい' finds kill", () => {
    const results = searchTools("プロセスを終了したい", tools);
    assert.ok(results.length > 0);
    assert.equal(results[0]!.tool.id, "kill");
  });

  it("'ネットワークのポートをスキャンしたい' finds nmap", () => {
    const results = searchTools("ネットワークのポートをスキャンしたい", tools);
    assert.ok(results.length > 0);
    assert.equal(results[0]!.tool.id, "nmap");
  });

  it("'ファイルの権限を変更したい' finds chmod", () => {
    const results = searchTools("ファイルの権限を変更したい", tools);
    assert.ok(results.length > 0);
    assert.equal(results[0]!.tool.id, "chmod");
  });
});

describe("Search — options", () => {
  it("limit controls max results", () => {
    const results = searchTools("file", tools, { limit: 3 });
    assert.ok(results.length <= 3);
  });

  it("higher threshold returns fewer results", () => {
    const loose = searchTools("file", tools, { threshold: 0.1 });
    const strict = searchTools("file", tools, { threshold: 5 });
    assert.ok(strict.length <= loose.length);
  });

  it("results are sorted by score descending", () => {
    const results = searchTools("search files", tools);
    for (let i = 1; i < results.length; i++) {
      assert.ok(results[i]!.score <= results[i - 1]!.score);
    }
  });

  it("each result has matchedOn populated", () => {
    const results = searchTools("git commit", tools);
    for (const r of results) {
      assert.ok(r.matchedOn.length > 0);
    }
  });
});
