# Phase 1 实施日志 · 文本/代码渲染替换为 Streamdown

> 对应 [refactor-plan.md](../refactor-plan.md) §6 Phase 1。
> 日期:2026-06-11 · 状态:✅ 完成

## 目标

用 **Streamdown**(react-markdown 流式 drop-in)替换自维护的
`MarkdownContent` + `CodeBlock`,移除 `react-markdown` /
`react-syntax-highlighter` / `remark-gfm`。收益:删自维护渲染代码 + 两个重依赖;
残缺 token 流式补全、Shiki 高亮、行号/复制、表格/数学/mermaid 开箱即用。

## 改动

依赖:

- 新增 `streamdown@^2.5.0`。
- 移除 `react-markdown`、`react-syntax-highlighter`、`remark-gfm`、
  `@types/react-syntax-highlighter`。

代码:

- [web/src/components/MarkdownContent.tsx](../../web/src/components/MarkdownContent.tsx)
  —— 内部换成 `<Streamdown>`:`parseIncompleteMarkdown`(流式不闪烁)、
  `shikiTheme={['github-light','github-dark']}`(深浅色),className 保留正文字号
  并约束代码块 `max-h-[70vh] overflow-auto`(沿用旧的限高滚动)。
- 删除 [web/src/components/CodeBlock.tsx](../../web/src/components/CodeBlock.tsx)
  —— 复制/换行/高亮/行号/限高全部由 Streamdown 内置接管。
- [web/src/index.css](../../web/src/index.css) —— 删除约 60 行 bespoke `.md` 正文 CSS;
  Markdown 元素样式改由 Streamdown + Tailwind 工具类提供。
- [web/tailwind.config.js](../../web/tailwind.config.js) —— `content` 增加
  `../node_modules/streamdown/dist/**/*.js`,让 Tailwind 扫描并生成 Streamdown
  渲染所用的工具类。
- [web/src/main.tsx](../../web/src/main.tsx) —— `import 'streamdown/styles.css'`
  (流式进入动画的 keyframes)。
- 新增 [web/src/vite-env.d.ts](../../web/src/vite-env.d.ts)(`vite/client` 类型,
  补 `*.css` 副作用导入声明)。

## 验收

- `tsc -b`:通过。
- `vite build`:通过。
- 包体显著瘦身:**976 kB → 643 kB**(gzip 332 → 200 kB),模块数 1361 → 340;
  Shiki/mermaid 拆为按需 chunk。CSS 18 → 25 kB(Tailwind 已收录 Streamdown 类)。
- SSR 冒烟:`renderToStaticMarkup(<Streamdown>)` 正常产出含 `<pre>` 的代码块。
- 后端未改;事件→渲染链路不变(Phase 0 的 `UiEvent` → `MarkdownContent`)。

## 备注

- 主 bundle 仍含 Shiki 核心(643 kB);后续可按需进一步 code-split,非本阶段目标。
- 代码块高亮/行号/复制/限高滚动由 Streamdown 默认提供;深浅色随 `.dark` 类切换,
  与既有 `darkMode: 'class'` 一致。
