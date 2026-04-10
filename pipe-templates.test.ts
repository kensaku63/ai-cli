/**
 * Pipe template smoke tests — verify that synthetic templates fire for the
 * specific benchmark queries they were written to cover. These protect the
 * +1.9pt Top-1 improvement from PR #22 (synthetic-knowledge Phase A) against
 * accidental regression in engine.ts or pipe-synthetic.json.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AiCliEngine } from "./engine.js";

const engine = new AiCliEngine();

async function expectTop(query: string, expectedId: string): Promise<void> {
  const results = await engine.discover(query, 3);
  assert.ok(results.length > 0, `no discovery result for "${query}"`);
  assert.equal(
    results[0]!.tool.id,
    expectedId,
    `expected ${expectedId} for "${query}" but got ${results[0]!.tool.id}`,
  );
}

describe("Synthetic pipe templates", () => {
  describe("synth:grep-to-less and synth:docker-logs-to-less", () => {
    it("routes grep->less to less", async () => {
      await expectTop(
        "grepの検索結果が大量なので、lessにパイプして閲覧したい",
        "less",
      );
    });

    it("routes docker logs->less to less", async () => {
      await expectTop(
        "Pipe the output of docker logs into less for paginated viewing",
        "less",
      );
    });
  });

  describe("synth:curl-to-gojq", () => {
    it("routes curl->gojq to gojq", async () => {
      await expectTop(
        "pipe curl output into gojq to extract the response status and message fields",
        "gojq",
      );
    });
  });

  describe("synth:diff-to-delta", () => {
    it("routes git diff syntax highlight to delta", async () => {
      await expectTop(
        "show the current git diff with syntax highlighting",
        "delta",
      );
    });

    it("routes Japanese git diff 横並び to delta", async () => {
      await expectTop("Gitの差分を横並びで見たい", "delta");
    });
  });

  describe("synth:make-to-tee-buildlog", () => {
    it("routes Japanese make buildlog save to make", async () => {
      await expectTop(
        "makeの出力をビルドログとしてbuild.logにも保存しつつ画面にも表示して",
        "make",
      );
    });

    it("does NOT hijack English pipe+tee+count query (expected=tee)", async () => {
      // This query should fall through to the builtin save-and-display template
      // which correctly picks tee as primary. Regression guard for the
      // overly-broad English pattern that lost pipe-en-060 during development.
      await expectTop(
        "pipe make output through tee to build.log and also count error lines with grep",
        "tee",
      );
    });
  });

  describe("synth:tail-follow-grep and synth:dmesg-filter", () => {
    it("routes access log realtime monitoring to tail", async () => {
      await expectTop(
        "Nginxのアクセスログを監視して、ステータスコード5xxのリクエストだけリアルタイムで表示したい",
        "tail",
      );
    });

    it("routes kernel messages USB to dmesg", async () => {
      await expectTop("show kernel messages related to USB devices", "dmesg");
    });
  });

  describe("synth:journalctl-filter", () => {
    it("routes boot kernel log to journalctl", async () => {
      await expectTop(
        "今回のブート以降のカーネルログだけ確認して、WARNING行を数えたい",
        "journalctl",
      );
    });
  });
});
