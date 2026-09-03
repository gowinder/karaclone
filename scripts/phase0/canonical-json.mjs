/**
 * Phase 0 唯一 canonical JSON 实现。
 *
 * 规则（见计划 Task 1 B 段）：
 * - 仅接受 JSON 的 null/boolean/string/有限数字/数组/普通对象。
 * - 对象 key 按 Unicode code point 递归升序；数组保序。
 * - 字符串保持原 Unicode code points，不做 NFC/NFD 归一化，按 JSON 必需规则转义。
 * - 数字使用 ECMAScript JSON.stringify 的最短十进制表示；`-0` 规范为 `0`。
 * - 拒绝 undefined、函数、symbol、BigInt、NaN、±Infinity、稀疏数组、
 *   重复解析 key、非普通对象及循环引用。
 * - 最终文本无空白/尾换行，UTF-8 编码后 SHA-256 lowercase hex。
 * - 计算 artifact 自身 hash 时递归排除所有名为 `canonicalSha256` 的自哈希字段；
 *   其他字段不得排除。
 *
 * preflight、四份 deploy、freeze、wire、manual 与客户端 manifest 全部调用此唯一实现。
 */

const encoder = new TextEncoder();

function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function sortObjectKeys(obj) {
  return Object.keys(obj).sort((a, b) => {
    for (let i = 0; i < a.length && i < b.length; i++) {
      const ca = a.codePointAt(i);
      const cb = b.codePointAt(i);
      if (ca !== cb) return ca - cb;
    }
    return a.length - b.length;
  });
}

/**
 * 生成 canonical JSON 文本（不含 `canonicalSha256` 字段）。
 * @param {unknown} value
 * @param {object} [opts]
 * @param {boolean} [opts.excludeSelfHash] 排除 `canonicalSha256` 字段
 * @returns {string}
 */
export function canonicalStringify(value, opts = {}) {
  const { excludeSelfHash = false } = opts;
  const seen = new Set();

  function stringifyValue(node) {
    if (node === null) return "null";
    if (typeof node === "boolean") return node ? "true" : "false";
    if (typeof node === "number") {
      if (!Number.isFinite(node)) {
        throw new TypeError(`canonical-json: non-finite number ${node}`);
      }
      if (Object.is(node, -0)) return "0";
      return JSON.stringify(node);
    }
    if (typeof node === "string") return JSON.stringify(node);
    if (typeof node === "bigint") {
      throw new TypeError("canonical-json: BigInt is not supported");
    }
    if (typeof node !== "object") {
      throw new TypeError(`canonical-json: unsupported value type ${typeof node}`);
    }
    if (seen.has(node)) throw new TypeError("canonical-json: circular reference");
    seen.add(node);
    try {
      if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) {
          if (!(i in node)) throw new TypeError("canonical-json: sparse array");
        }
        const parts = node.map((item) => stringifyValue(item));
        return `[${parts.join(",")}]`;
      }
      if (!isPlainObject(node)) {
        throw new TypeError("canonical-json: non-plain object");
      }
      if (Object.getOwnPropertySymbols(node).length > 0) {
        throw new TypeError("canonical-json: symbol keys are not supported");
      }
      const keys = sortObjectKeys(node);
      const parts = [];
      for (const key of keys) {
        const keyDesc = Object.getOwnPropertyDescriptor(node, key);
        if (keyDesc && "get" in keyDesc && keyDesc.get) {
          throw new TypeError("canonical-json: getter property");
        }
        if (excludeSelfHash && key === "canonicalSha256") continue;
        const val = node[key];
        if (val === undefined) {
          throw new TypeError("canonical-json: undefined property value");
        }
        parts.push(`${JSON.stringify(key)}:${stringifyValue(val)}`);
      }
      return `{${parts.join(",")}}`;
    } finally {
      seen.delete(node);
    }
  }

  return stringifyValue(value);
}

/**
 * 计算 canonical UTF-8 文本的 SHA-256（lowercase hex）。
 * 计算 artifact 自身 hash 时始终递归排除所有名为 `canonicalSha256` 的自哈希字段。
 */
export async function canonicalJsonHash(value) {
  const text = canonicalStringify(value, { excludeSelfHash: true });
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
