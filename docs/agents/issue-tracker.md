# 问题跟踪：GitHub

工作项与讨论位于 [4o4E/RunForge Issues](https://github.com/4o4E/RunForge/issues)，使用 `gh` CLI。PRs as a request surface: no.

## 规格与工作项

- 当前规格、变更方案、架构决定和任务清单统一保存在 OpenSpec。
- `to-spec` 写入本地 OpenSpec，不自动创建一个复制规格正文的 Issue。
- `to-tickets` 先维护变更的 `tasks.md`，用户要求发布工作项时再创建 Issue。
- Issue 正文引用 change 路径、相关规格和任务编号，并记录负责内容、依赖与讨论；不复制完整设计与规格。
- GitHub 上的工作项完成或关闭不等于应用部署，也不自动将 OpenSpec 未验收任务勾选完成。

## 操作

从项目仓库执行，或显式指定 `--repo 4o4E/RunForge`：

```bash
gh issue view <number> --json number,title,body,labels,comments
gh issue list --state open --json number,title,labels,url
```

用户授权创建后，使用 `gh issue create --title <标题> --body-file <正文文件>`。正文文件按当前工作区临时资料规则登记，不保存凭证。修改、评论、标签变更和关闭同样必须属于用户授权范围；只读调查不会自动发布或关闭工作项。

有父任务时使用 GitHub 原生 sub-issue 与依赖关系；实际 CLI/API 能力以已安装版本为准。无法使用原生关系时，在正文明确写出 `Part of #<parent>` 和 `Blocked by #<number>`，不把文本引用冒充原生依赖。

## Wayfinder

大型工作的 map 与子工作项可以放在 GitHub，已确认的需求和决定仍更新到对应 OpenSpec 变更。map 只记录工作索引、问题和引用，不成为第二份架构决定来源。
