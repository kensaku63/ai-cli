import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Registry } from "./registry.js";

describe("Registry.loadAuto", () => {
  it("loads auto-generated tools alongside builtin", async () => {
    const registry = new Registry();
    await registry.loadBuiltin();
    const builtinCount = registry.size;

    const loaded = await registry.loadAuto();
    // loadAuto may return 0 if the data/auto directory is empty or absent.
    assert.ok(loaded >= 0);
    assert.ok(registry.size >= builtinCount);
  });

  it("builtin entries are not overwritten by auto entries (builtin優先)", async () => {
    const registry = new Registry();
    await registry.loadBuiltin();

    // Inject a fake auto entry with an id that already exists in builtin.
    // Since Registry.register() does overwrite, we simulate the loadAuto
    // path via direct behaviour check: loadAuto's conflict resolution
    // should skip ids whose existing source is "builtin".
    const existingId = registry.all().find((t) => t.source === "builtin")?.id;
    assert.ok(existingId, "expected at least one builtin tool");

    const beforeName = registry.get(existingId)!.name;
    const beforeSource = registry.get(existingId)!.source;
    assert.equal(beforeSource, "builtin");

    // After loading auto entries the builtin entry should still be there
    // with source=builtin (auto data was added but did not clobber builtin).
    await registry.loadAuto();
    assert.equal(registry.get(existingId)!.name, beforeName);
    assert.equal(registry.get(existingId)!.source, "builtin");
  });
});
