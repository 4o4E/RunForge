# 空间模型、上下文显示与 Skill 生命周期

日期：2026-09-21

## 已核对的现状

- 空间配置已经包含 `model.defaultModelRef`、`model.allowedModelRefs` 和可选的
  `model.contextBudget`。
- 空间管理界面已经提供默认模型选择和允许模型列表；保存时由
  `SpaceConfigService` 校验模型属于当前租户目录。
- run 接纳时保存空间模型快照，执行时使用 `run.model_ref` 和空间快照中的上下文参数。
- Skill 激活事件会恢复 `activeSkills`，但激活结果原先在下一次模型请求后被标记为
  `skill-activation-consumed` 并作为压缩事件推送；这会使前端错误显示“已压缩上下文”，
  也会使 Skill 正文不再出现在后续请求中。

## 本次调整

- `ContextManager` 增加运行时派生的 active Skill 说明。说明位于首个用户消息之前，
  不写入 `messages`，也不会被滑动窗口和旧消息摘要移除。
- run 恢复时根据 `skill_activated` 事件重新读取 Skill 入口说明；新激活 Skill 后立即
  更新当前 run 的模型上下文。
- Skill 激活结果仍然可以在模型视图中折叠以避免重复占用；完整入口说明由当前 run 的
  active Skill 派生消息持续注入，直到 run 结束。下一 run 仍然需要重新激活。
- 前端压缩事件只由真实上下文预算整理产生。Skill 说明整理、显示参数裁剪和 run 结束后的
  历史整理不会再生成“已压缩上下文”事件；消息持久化标记仍按原有审计规则保留。
- 更新 Skill 系统设计文档，明确入口说明保持到 run 结束，附属文件仍然按需读取。

## 验证

- 已修改 Skill 激活测试：后续模型请求继续收到完整入口说明，下一 run 不继承，且不产生
  Skill 激活压缩事件。
- 服务端类型检查、前端类型检查和服务端完整 293 项测试通过。
- 真实视频 run `ru_GotPGZv2Fl` 激活 Skill 后，完整入口说明持续出现在之后 15 次
  provider 请求中直到 run 结束；本次 run 没有产生压缩事件。
- 空间模型选择已有服务端、API 和前端实现，本次未重复改动数据库或空间协议。
