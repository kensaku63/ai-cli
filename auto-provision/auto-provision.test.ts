import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { calculateTrust } from "./trust.js";
import { selectManager, detectManagers } from "./detector.js";
import type { ToolMetadata } from "../tool-registry/schema.js";
import type { DetectedManager } from "./detector.js";

function makeTool(overrides: Partial<ToolMetadata> = {}): ToolMetadata {
  return {
    id: "test-tool",
    name: "test",
    type: "cli",
    categories: [],
    tags: [],
    description: "A test tool for unit testing purposes",
    description_ja: "テスト用ツール",
    install: { brew: "test", apt: "test", check: "test --version" },
    subcommands: [],
    intents: [],
    source: "builtin",
    updated_at: "2026-04-09",
    ...overrides,
  };
}

const MOCK_MANAGERS: DetectedManager[] = [
  { name: "brew", path: "/opt/homebrew/bin/brew", version: "4.0.0" },
  { name: "npm", path: "/usr/bin/npm", version: "10.0.0" },
  { name: "pip", path: "/usr/bin/pip", version: "24.0" },
];

// ─── Trust Score Tests ───

describe("Trust — calculateTrust", () => {
  it("builtin tool with full install info scores high", () => {
    const tool = makeTool({ source: "builtin" });
    const result = calculateTrust(tool);
    assert.equal(result.level, "high");
    assert.ok(result.score >= 0.7);
  });

  it("community tool with full install info scores high (source weight is 40%)", () => {
    const tool = makeTool({ source: "community" });
    const result = calculateTrust(tool);
    // source=0.6*0.4=0.24, check=1.0*0.3=0.3, methods=0.7*0.2=0.14, desc=1.0*0.1=0.1 → 0.78 → high
    assert.equal(result.level, "high");
    assert.equal(result.breakdown.registrySource, 0.6);
  });

  it("community tool with minimal install info scores medium", () => {
    const tool = makeTool({ source: "community", install: { check: "x" } });
    const result = calculateTrust(tool);
    // source=0.6*0.4=0.24, check=1.0*0.3=0.3, methods=0.0*0.2=0, desc=1.0*0.1=0.1 → 0.64 → medium
    assert.equal(result.level, "medium");
  });

  it("auto-discovered tool with no check scores low", () => {
    const tool = makeTool({
      source: "auto",
      install: {},
      description: "",
      description_ja: undefined,
    });
    const result = calculateTrust(tool);
    assert.equal(result.level, "low");
    assert.ok(result.score < 0.4);
  });

  it("breakdown weights sum to 1.0", () => {
    const tool = makeTool();
    const result = calculateTrust(tool);
    // All signals are 1.0 for a fully populated builtin tool
    assert.equal(result.breakdown.registrySource, 1.0);
    assert.equal(result.breakdown.installCheck, 1.0);
    assert.ok(result.breakdown.methodsCount > 0);
    assert.equal(result.breakdown.description, 1.0);
  });

  it("methods count: 3+ gives 1.0, 2 gives 0.7, 1 gives 0.4", () => {
    const three = makeTool({ install: { brew: "a", apt: "b", npm: "c", check: "x" } });
    const two = makeTool({ install: { brew: "a", apt: "b", check: "x" } });
    const one = makeTool({ install: { brew: "a", check: "x" } });

    assert.equal(calculateTrust(three).breakdown.methodsCount, 1.0);
    assert.equal(calculateTrust(two).breakdown.methodsCount, 0.7);
    assert.equal(calculateTrust(one).breakdown.methodsCount, 0.4);
  });
});

// ─── Detector Tests ───

describe("Detector — selectManager", () => {
  it("selects brew when available and tool supports it", () => {
    const tool = makeTool({ install: { brew: "test-pkg", npm: "test-pkg" } });
    const result = selectManager(tool.install, MOCK_MANAGERS);
    assert.ok(result);
    assert.equal(result.manager, "brew");
    assert.equal(result.packageName, "test-pkg");
  });

  it("falls back to npm when brew is not in install", () => {
    const tool = makeTool({ install: { npm: "test-pkg", pip: "test-pkg" } });
    const result = selectManager(tool.install, MOCK_MANAGERS);
    assert.ok(result);
    assert.equal(result.manager, "npm");
  });

  it("falls back to pip when only pip is available", () => {
    const tool = makeTool({ install: { pip: "test-pkg" } });
    const result = selectManager(tool.install, MOCK_MANAGERS);
    assert.ok(result);
    assert.equal(result.manager, "pip");
  });

  it("returns null when no manager matches", () => {
    const tool = makeTool({ install: { cargo: "test-pkg" } });
    const result = selectManager(tool.install, MOCK_MANAGERS);
    assert.equal(result, null);
  });

  it("returns null when tool has no install methods", () => {
    const tool = makeTool({ install: {} });
    const result = selectManager(tool.install, MOCK_MANAGERS);
    assert.equal(result, null);
  });

  it("respects priority order: brew > apt > npm > pip > cargo > choco", () => {
    const allManagers: DetectedManager[] = [
      { name: "pip", path: "/usr/bin/pip", version: "24" },
      { name: "brew", path: "/opt/homebrew/bin/brew", version: "4" },
      { name: "npm", path: "/usr/bin/npm", version: "10" },
    ];
    const tool = makeTool({ install: { pip: "pkg-pip", brew: "pkg-brew", npm: "pkg-npm" } });
    const result = selectManager(tool.install, allManagers);
    assert.ok(result);
    assert.equal(result.manager, "brew");
    assert.equal(result.packageName, "pkg-brew");
  });
});

describe("Detector — detectManagers", () => {
  it("returns an array of detected managers", async () => {
    const managers = await detectManagers();
    assert.ok(Array.isArray(managers));
    for (const m of managers) {
      assert.ok(m.name);
      assert.ok(m.path);
    }
  });
});
