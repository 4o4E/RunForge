# 经验命令

用 JSON 文件传参；只保存可共享的结论和脱敏证据。不要提交实际业务输入。

## 查询

`brix experience search query.json`

```json
{"hostname":"catalog.example","path":"/search","task":"find-source","conditions":{"language":"en","device":"desktop"}}
```

字段是最终域名、无查询和片段的路径、任务键、已确认的条件。`conditions` 可含 `language`、`device`（`desktop`/`mobile`）、`auth`（`signed-in`/`signed-out`）、`variant`（短键）。只传实际观察到的条件。路径含账号或私有标识时不查询或共享该经验。`brix experience show ID` 查看所有版本和反馈。

## 发布

`brix experience publish note.json`

```json
{
  "scope": {"hostname":"catalog.example","path":"/search","task":"find-source","conditions":{"language":"en","device":"desktop"}},
  "advice": "打开结果卡片的原站链接。",
  "check": "卡片已显示原站链接，打开后核对页面来源。",
  "invalidWhen": "结果已加载，但卡片不再提供原站链接。",
  "evidence": {
    "sessionId": "实际会话ID",
    "page": {"hostname":"catalog.example","path":"/search","task":"find-source","conditions":{"language":"en","device":"desktop"}},
    "ready": true,
    "expected": "结果卡片提供原站链接。",
    "observed": "卡片提供原站链接，链接跳到来源页面。"
  }
}
```

路径默认精确；确实适用所有子路径时才在 `scope` 设置 `mode: "prefix"`。可用 UTC `expiresAt` 设更早到期时间。改范围或正文时附原 `id` 和当前 `ifVersion`；冲突先看最新版本，不直接覆盖。

## 反馈

`brix experience report ID feedback.json` 接收 `{version, kind, evidence}`；`evidence` 形状同上，已有验证写实际会话 ID，不能用虚构或随意改写的 ID。

| `kind` | 怎么用 |
|---|---|
| `verified` | 独立复验通过，且页面就绪。 |
| `temporary_failure` | 页面未就绪、验证被阻断等；不填 `ready`。 |
| `contradicted` | 范围匹配、页面就绪、结果反驳经验；加 `issue` 短键，例如 `source-link-absent`。同一问题用同一键。 |
| `resolved` | 用另一个会话在相同页面条件下验证冲突已消失；加原 `issue` 和 `resolution` 说明依据。 |
| `withdrawn` | 维护者有证据撤回该版本；不填 `ready`。 |

远程 HTTP 对应 `POST /experiences/search`、`POST /experiences`、`GET /experiences/:id`、`POST /experiences/:id/feedback`，复用 Brix Token。时间字段是服务器 Unix 毫秒。