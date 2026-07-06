---
name: data-analysis
description: 用一套可复查的数据分析流程处理 CSV、Parquet、JSON、数据库导出或查询结果，包含质量检查、聚合、分组、趋势、异常和结论验证。Use when the task asks for data profiling, transformation, statistical summaries, or analytical findings.
allowed-tools: shell grep file_read file_write glob
metadata:
  runforge.tool-scope: workspace-readwrite
---

# Data Analysis

## Workflow

1. 明确问题：写下分析对象、指标口径、时间范围、分组维度和输出形式。
2. 盘点数据：确认文件、表或查询结果的位置、格式、行列规模和字段含义。
3. 做质量检查：统计缺失、重复、异常值、类型错配、时间范围断点和采样偏差。
4. 建立基线：先给总量、均值、中位数、分位数、分组占比和趋势，再回答业务问题。
5. 逐步深入：只在基线支持的方向上做交叉分析、漏斗、留存、相关性或异常定位。
6. 复核结论：每个结论都要能对应到查询、样本范围或计算方法。

## Tooling

- 小型 CSV/JSON：可以用 `python` 标准库或 `jq`。
- 中大型 CSV/Parquet：优先用 DuckDB，本地 SQL 能直接读文件且不需要导入服务端数据库。
- 数据库结果：先用 `database-access` skill 导出小样本或聚合结果，再继续分析。
- 需要稳定概览 CSV 时，可以运行 `scripts/profile_csv.py`。

更具体的分析框架见 `references/analysis-framework.md`。DuckDB 使用指南见 `references/duckdb.md`。

## Output

最终回答要包含：

- 数据来源和过滤范围。
- 关键指标和主要发现。
- 支撑发现的计算口径。
- 异常、缺失和不确定性。
- 后续建议或需要补充的数据。
