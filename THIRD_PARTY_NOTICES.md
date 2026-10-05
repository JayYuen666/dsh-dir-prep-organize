# Third-party notices

本包自身代码以 MIT 发布，见 [`LICENSE`](./LICENSE)。但发布物里并非全部内容都是本仓原创：
内置角色库 `agents/` 来自下面的第三方项目，且占发布体积的绝大部分。MIT 要求「上述版权声明与
本许可声明须包含在软件的所有副本或实质性部分中」，因此那一段必须随包发出——本文件就是它的
载体。

## 内置角色库 `agents/`

- 上游项目：`agency-agents-zh`
- 上游仓库：https://github.com/jnMetaCode/agency-agents-zh
- 上游 npm 包：https://www.npmjs.com/package/agency-agents-zh
- 上游许可：MIT
- 本仓的改动：整体移入本插件的 `agents/` 目录；未改动角色正文。上游的 `integrations/`
  目录（面向 Claude Code / Cursor / Gemini CLI 等外部工具的转换件与安装脚本）对 dsh 插件
  无作用，也未被本仓使用，故未随本包分发。

上游许可原文照录如下。

```
MIT License

Copyright (c) 2025 Michael Sitarzewski (original English version)
Copyright (c) 2026 jnMetaCode (Chinese translation and localization)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

> 版权年份是许可条款要求随附的内容，不是无用的时间标记，故按上游原文保留。

## 运行期依赖

运行期依赖的许可由各自包随包分发，本包不再重复其文本：`@deepseek-ai/cosmokit`、
`@deepseek-ai/dsh-brand`、`@deepseek-ai/schemastery`、`@jayyuen66/dsh-plugin-shared`。
其中 `@deepseek-ai/cosmokit` 仅出现在本包发布的类型声明里——schemastery 的 `Schema` 类型
把 `Dict` 取自 cosmokit，声明文件点名它就必须让它可解析，故列为运行期依赖而非开发依赖。