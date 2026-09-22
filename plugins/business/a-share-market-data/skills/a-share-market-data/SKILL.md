---
name: a-share-market-data
description: 查询 A 股标的、主要指数、实时行情、分时和不同周期 K 线；只提供数据，不代替事实搜索或投资判断。
---

分析 A 股个股、板块或大盘时使用本 Skill。先把请求写入当前工作目录中的 JSON 文件，再运行：

`node <root>/scripts/eastmoney.mjs <请求.json>`

`<root>` 是本 Skill 根目录。支持以下请求：

- `{"action":"search","query":"贵州茅台"}`：解析名称、代码或简称。
- `{"action":"quote","code":"600519"}`：实时价格、涨跌、量比、换手和市值。
- `{"action":"intraday","code":"600519","count":120}`：最近分时数据。
- `{"action":"kline","code":"600519","level":"day","count":120}`：K 线；level 为 m1、m5、m30、day、week、month。
- `{"action":"overview"}`：上证指数、深证成指和创业板指实时行情。
- `{"action":"collect","code":"600519"}`：一次取得实时、分时、日线、30 分钟和 5 分钟数据。

名称或代码不确定时必须先 search，并使用返回的 `secid` 或 `code` 继续查询。输出中的 `source`
和 `retrievedAt` 要保留在分析依据中。行情数据、外部新闻和模型推断必须分开；新闻、公告、政策、
财报和时效事实使用空间搜索能力核对，不能根据涨跌反推事件。给出交易判断时写明数据时间、风险位、
失效条件和不确定性，不把任何单一指标当成确定结论。
