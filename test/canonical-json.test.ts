import { describe, expect, it } from "vitest";
import { canonicalStringify, canonicalJsonHash } from "../scripts/phase0/canonical-json.mjs";

const sha256Hex = async (text: string): Promise<string> => {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
};

describe("canonical-json", () => {
  it("UTF-8 与基础文本向量", async () => {
    expect(canonicalStringify(null)).toBe("null");
    expect(canonicalStringify(true)).toBe("true");
    expect(canonicalStringify(42)).toBe("42");
    expect(canonicalStringify("hello")).toBe('"hello"');
    expect(await canonicalJsonHash({})).toBe(await sha256Hex("{}"));
    expect(await canonicalJsonHash([])).toBe(await sha256Hex("[]"));
  });

  it("多语言与代理对保持原 Unicode code points", () => {
    expect(canonicalStringify("中文")).toBe('"中文"');
    expect(canonicalStringify("𝄞")).toBe('"𝄞"'); // U+1D11E surrogate pair，不转义
    expect(canonicalStringify("a\u0301")).toBe('"a\u0301"'); // 组合变音符，不做 NFC 归一化
    expect(canonicalStringify("e\u0301")).not.toBe(canonicalStringify("\u00e9"));
  });

  it("对象 key 按 Unicode code point 递归升序", () => {
    expect(canonicalStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalStringify({ z: { d: 1, c: 2 }, a: 0 })).toBe('{"a":0,"z":{"c":2,"d":1}}');
    // code point 升序：'B'(66) < 'a'(97)
    expect(canonicalStringify({ B: 1, a: 2 })).toBe('{"B":1,"a":2}');
  });

  it("数字最短十进制表示与 -0 规范为 0", () => {
    expect(canonicalStringify(1e21)).toBe(JSON.stringify(1e21));
    expect(canonicalStringify(-0)).toBe("0");
    expect(canonicalStringify(0.5)).toBe("0.5");
    expect(canonicalStringify({ x: -0, y: 0 })).toBe('{"x":0,"y":0}');
  });

  it("字符串按 JSON 必需规则转义", () => {
    expect(canonicalStringify('a"b\\c\nd')).toBe('"a\\"b\\\\c\\nd"');
  });

  it("拒绝非法值", () => {
    for (const bad of [undefined, NaN, Infinity, -Infinity, BigInt(1), () => {}, Symbol("x")]) {
      expect(() => canonicalStringify(bad)).toThrow();
    }
    expect(() => canonicalStringify([1, , 3])).toThrow(); // 稀疏数组
    const circ: Record<string, unknown> = {};
    circ.self = circ;
    expect(() => canonicalStringify(circ)).toThrow(); // 循环引用
    expect(() => canonicalStringify(new Date())).toThrow(); // 非普通对象
    expect(() => canonicalStringify(new Map())).toThrow();
    expect(() => canonicalStringify({ a: undefined })).toThrow();
  });

  it("自哈希字段递归排除", async () => {
    const artifact = {
      b: 1,
      canonicalSha256: "deadbeef",
      nested: { canonicalSha256: "x", v: 2 },
    };
    const text = canonicalStringify(artifact, { excludeSelfHash: true });
    expect(text).toBe('{"b":1,"nested":{"v":2}}');
    // hash 与排除后的文本一致
    expect(await canonicalJsonHash(artifact)).toBe(await sha256Hex(text));
  });

  it("输入不变性", () => {
    const input: Record<string, unknown> = { b: 1, a: [3, 2] };
    const before = JSON.stringify(input);
    canonicalStringify(input);
    expect(JSON.stringify(input)).toBe(before);
  });

  it("跨 artifact 一致性：同一结构 hash 稳定", async () => {
    const a = { page: 1, items: [{ id: "x", n: 1 }] };
    const b = { items: [{ n: 1, id: "x" }], page: 1 };
    expect(await canonicalJsonHash(a)).toBe(await canonicalJsonHash(b));
  });
});
