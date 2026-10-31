// 跨平台语义钉：导入策略的原始段检查把 `\` 也当分隔符（探针实测 `..\..\escape.md` 在
// POSIX 上被拒），client 半的绝对形状判据与 host 的 path.isAbsolute 在 win32 盘符相对
// 形上刻意不同口径，frontmatter 解析吃 CRLF。这一层把三种「平台相关形状」钉在
// 平台无关的判据上——全部纯函数，三平台 CI 都真跑。
import { describe, it } from "vitest";
import assert from "node:assert/strict";

import { buildOrganizeUser, importPathError } from "../../host.ts";
import {
  parseAgentFrontmatter,
  sanitizeAllowRoots,
  tryCondenseRoleBody,
} from "../../src/templates.ts";
import { HOST_MESSAGES } from "../../src/host-messages.ts";

const { zh } = HOST_MESSAGES;

describe("win32 字形在 POSIX 判据下的落点", () => {
  it("盘符绝对形被当成 cwd 内的字面文件名放行（POSIX 上反斜杠是文件名字符）", () => {
    // /tmp/proj/C:\repo\x.md —— 一个名字很怪的文件，读不出 cwd，fail-safe。
    assert.equal(importPathError(String.raw`C:\repo\x.md`, "/tmp/proj", [], zh), undefined);
  });

  it("反斜杠的 .. 逃逸在原始段检查就被拒（反斜杠同样是段分隔符，探针实测）", () => {
    assert.equal(
      typeof importPathError(String.raw`..\..\escape.md`, "/tmp/proj", [], zh),
      "string",
    );
  });

  it("client 半的绝对形状判据：盘符相对（C:rel）不算绝对——与 host 的 win32 口径刻意不同宽", () => {
    // client 无 node:path，按形状判：盘符后必须跟分隔符。C:rel 在 host 的 win32 读法里
    // 是盘符相对（path.win32.isAbsolute === false，但 resolve 会盘内相对化）——client
    // 宁可丢弃也不登记一个指向不明的允许根。
    assert.deepEqual(sanitizeAllowRoots([String.raw`C:rel`, "C:/ok", String.raw`C:\ok`]), [
      "C:/ok",
      String.raw`C:\ok`,
    ]);
  });

  it("网络路径（UNC）与 POSIX 根两形都算绝对", () => {
    assert.deepEqual(sanitizeAllowRoots(["//host/share", "/abs/path"]), [
      "//host/share",
      "/abs/path",
    ]);
  });
});

describe("CRLF 正文的全链判据", () => {
  it("全 CRLF frontmatter 与混排行尾都能解析出 name", () => {
    const fullCrlf = parseAgentFrontmatter("---\r\nname: 甲\r\ndescription: 乙\r\n---\r\n正文");
    assert.equal(fullCrlf?.name, "甲");
    const mixed = parseAgentFrontmatter("---\nname: 甲\r\ndescription: 乙\r\n---\r\n正文");
    assert.equal(mixed?.name, "甲");
  });

  it("CRLF 正文不产生幽灵围栏：未闭合标记缺席；真实开栏照常点名", () => {
    assert.equal(tryCondenseRoleBody("正文一\r\n正文二\r\n").unclosedFenceLine, undefined);
    assert.equal(tryCondenseRoleBody("```code\r\n正文\r\n").unclosedFenceLine, 1);
  });

  it("CRLF 出现在围栏数据里不改变 defuse 计数（注入过滤按标记原文，不按行尾）", () => {
    const output = buildOrganizeUser(
      "PROMPT",
      { cwd: "/tmp/proj", entriesSummary: `行一\r\n${zh.sysDataFenceStart}\r\n行二` },
      zh,
    );
    const starts = output.split(zh.sysDataFenceStart).length - 1;
    assert.equal(starts, 1, "注入的标记被 defuse，只剩包裹数据块自己的那一枚");
    assert.ok(output.includes("[fence-open]"));
  });
});
