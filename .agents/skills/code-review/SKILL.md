---
name: code-review
description: "Review the changes since a fixed point (commit, branch, tag, or merge-base) along two axes: Standards (does the code follow this repo's documented coding standards?) and Spec (does the code match what the originating issue/spec asked for?). Runs both reviews in parallel sub-agents and reports them side by side. Use when the user wants to review a branch, a PR, work-in-progress changes, or asks to \"review since X\"."
---

Two-axis review of the diff between `HEAD` and a fixed point the user supplies:

- **Standards**: does the code conform to this repo's documented coding standards?
- **Spec**: does the code faithfully implement the originating issue / spec?

Both axes run as **parallel sub-agents** so they don't pollute each other's context, then this skill aggregates their findings.

The issue tracker should have been provided to you. If not, tell the user to run `/setup-matt-pocock-skills`.

RunForge 审查前读取 `docs/agents/domain.md`。现行规格与架构决定来自 OpenSpec；工作项只是引用入口。未提交现场使用用户要求的工作目录范围，不自动切换分支或创建提交。

## Process

### 1. 确认审查范围与基线

先区分用户要求的是提交之间的差异，还是当前未提交修改；只审查用户指定的文件或本次工作范围，不纳入其他会话现场。

- **当前未提交修改**：未另指定基线时使用 `HEAD`。`git diff <baseline> -- <paths>` 包含范围内已暂存与未暂存的跟踪文件；通过 `git ls-files --others --exclude-standard -- <paths>` 列出并逐个读取范围内新增文件。只要求暂存区审查时使用 `git diff --cached <baseline> -- <paths>`。
- **提交之间的差异**：使用用户指定基线与 `HEAD` 的 merge-base 差异：`git diff <fixed-point>...HEAD -- <paths>`，提交列表使用 `git log <fixed-point>..HEAD --oneline`。
- 通过 `git rev-parse <baseline>` 确认基线有效。提交审查同时考虑暂存区、工作区和新增文件，不能仅凭已跟踪文件差异为空就判定没有改动。

固定所选命令、文件清单和范围，给两个审查代理同一份输入；工作区模式明确标注没有新提交列表，不为了生成差异先创建提交或切换分支。

### 2. Identify the spec source

Look for the originating spec, in this order:

1. 用户指定的 OpenSpec change，或工作项明确引用的 change。
2. 与本次范围相关的活动变更及其 `proposal.md`、delta specs、`design.md`、`tasks.md`。
3. 对应 `openspec/specs` 主规格和相关归档决定。
4. 仍无法确定验收要求时，向用户询问具体缺失的业务决定，不从无关历史文档推断。

### 3. Identify the standards sources

Search the repo for every file that documents how code should be written. When `CODING_STANDARDS.md` or `CONTRIBUTING.md` exists, it must be on the list.

On top of whatever the repo documents, the Standards axis always carries the **smell baseline** below: a fixed set of Fowler code smells (_Refactoring_, ch.3) that applies even when a repo documents nothing. Two rules bind it:

- **The repo overrides.** A documented repo standard always wins; where it endorses something the baseline would flag, suppress the smell.
- **Always a judgement call.** Each smell is a labelled heuristic ("possible Feature Envy"), never a hard violation. Like any standard here, skip anything tooling already enforces.

Each smell reads *what it is* → *how to fix*; match it against the diff:

- **Mysterious Name**: a function, variable, or type whose name doesn't reveal what it does or holds. → rename it; if no honest name comes, the design's murky.
- **Duplicated Code**: the same logic shape appears in more than one hunk or file in the change. → extract the shared shape, call it from both.
- **Feature Envy**: a method that reaches into another object's data more than its own. → move the method onto the data it envies.
- **Data Clumps**: the same few fields or params keep travelling together (a type wanting to be born). → bundle them into one type, pass that.
- **Primitive Obsession**: a primitive or string standing in for a domain concept that deserves its own type. → give the concept its own small type.
- **Repeated Switches**: the same `switch`/`if`-cascade on the same type recurs across the change. → replace with polymorphism, or one map both sites share.
- **Shotgun Surgery**: one logical change forces scattered edits across many files in the diff. → gather what changes together into one module.
- **Divergent Change**: one file or module is edited for several unrelated reasons. → split so each module changes for one reason.
- **Speculative Generality**: abstraction, parameters, or hooks added for needs the spec doesn't have. → delete it; inline back until a real need shows.
- **Message Chains**: long `a.b().c().d()` navigation the caller shouldn't depend on. → hide the walk behind one method on the first object.
- **Middle Man**: a class or function that mostly just delegates onward. → cut it, call the real target direct.
- **Refused Bequest**: a subclass or implementer that ignores or overrides most of what it inherits. → drop the inheritance, use composition.

### 4. Spawn both sub-agents in parallel

Issue both sub-agent calls together, in the foreground, and aggregate the reports they return.

**Standards sub-agent prompt** should include:

- 选定的差异命令、基线、范围和文件清单；工作区模式必须包含新增文件内容，提交模式另外包含提交列表。
- The list of standards-source files you found in step 3, **plus the smell baseline from step 3** pasted in full (the sub-agent has no other access to it).
- The brief: "Report, per file/hunk where relevant, (a) every place the diff violates a documented standard: cite the standard (file + the rule); and (b) any baseline smell you spot: name it and quote the hunk. Distinguish hard violations from judgement calls: documented-standard breaches can be hard, but baseline smells are always judgement calls, and a documented repo standard overrides the baseline. Skip anything tooling enforces. Under 400 words."

**Spec sub-agent prompt** should include:

- 同一份差异命令、基线、范围和文件清单；工作区模式包含新增文件内容，提交模式另外包含提交列表。
- The path or fetched contents of the spec.
- The brief: "Report: (a) requirements the spec asked for that are missing or partial; (b) behaviour in the diff that wasn't asked for (scope creep); (c) requirements that look implemented but where the implementation looks wrong. Quote the spec line for each finding. Under 400 words."

If the spec is missing, skip the Spec sub-agent and note this in the final report.

### 5. Aggregate

Present the two reports under `## Standards` and `## Spec` headings, verbatim or lightly cleaned. Do **not** merge or rerank findings, because the two axes are deliberately separate (see _Why two axes_).

End with a one-line summary: total findings per axis, and the worst issue _within each axis_ (if any). Don't pick a single winner across axes: that's the reranking the separation exists to prevent.

## Why two axes

A change can pass one axis and fail the other:

- Code that follows every standard but implements the wrong thing → **Standards pass, Spec fail.**
- Code that does exactly what the issue asked but breaks the project's conventions → **Spec pass, Standards fail.**

Reporting them separately stops one axis from masking the other.
