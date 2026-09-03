import { describe, expect, it } from "vitest";
import { parseQueueMessage } from "../src/queue/contracts";

const valid = {
  bookmarkId: "bm_1",
  jobId: "job_1",
  urlSnapshot: "https://example.com/a",
  requestedAt: "2026-09-03T00:00:00.000Z",
};

describe("queue contract", () => {
  it("精确四字段通过", () => {
    const msg = parseQueueMessage(valid);
    expect(msg).toEqual(valid);
  });

  it("缺失字段失败", () => {
    const { requestedAt, ...rest } = valid;
    expect(() => parseQueueMessage(rest)).toThrow();
  });

  it("额外字段失败", () => {
    expect(() => parseQueueMessage({ ...valid, kind: "probe" })).toThrow();
    expect(() => parseQueueMessage({ ...valid, probeId: "p1" })).toThrow();
  });

  it("序列化 UTF-8 字节数 < 2048", () => {
    const msg = parseQueueMessage(valid);
    const bytes = new TextEncoder().encode(JSON.stringify(msg)).length;
    expect(bytes).toBeLessThan(2048);
  });

  it("等于或超过 2048 字节必须失败", () => {
    const big = "x".repeat(3000);
    expect(() => parseQueueMessage({ ...valid, urlSnapshot: `https://example.com/${big}` })).toThrow();
  });
});
