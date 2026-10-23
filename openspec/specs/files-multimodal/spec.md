# 文件与多模态

## Purpose

约定会话文件、附件读取与媒体覆盖范围。实现入口：`server/src/files/`、`server/src/api/files.ts`、`server/src/tools/fileRead.ts`；解释见 `docs/multimodal-input-design.md`。

## Requirements

### Requirement: 会话文件与用户文件分离

系统 SHALL 将会话普通文件保存在 `<workspaceRoot>/<spaceId>/c/<threadId>`，将用户跨会话文件保存在独立用户目录。Web 文件接口不得将只读托管资源视为普通用户文件或跟随用户文件中的符号链接。

#### Scenario: 文件面板请求托管插件资源
- **WHEN** 用户尝试通过普通文件接口操作托管资源
- **THEN** 系统不提供普通文件写入权限，不跟随链接扩展授权

### Requirement: 上传完整性

multipart 上传 SHALL 使用同目录临时文件，完整接收后才替换目标；单文件上限为 1 GiB，中断或超限时清理临时文件。

#### Scenario: 上传中断
- **WHEN** 文件流在接收完成前中断
- **THEN** 保留原目标文件并清理本次临时文件，不发布不完整目标

### Requirement: 图片输入真实性

系统 SHALL 按实际文件内容识别和解码图片；模型不支持或图片不满足输入边界时明确说明。图片分析 SHALL 使用多模态，不以自动安装 OCR 替代被拒绝的图片输入。

#### Scenario: 模型不支持图片
- **WHEN** 当前模型的已保存能力不支持图片
- **THEN** 不发送图片字节，并明确图片没有进入模型，不能声称已查看图片

#### Scenario: 历史图片已经消费
- **WHEN** 后续请求不再需要之前的图片
- **THEN** 保留文件引用但不重复装载图片；需要重新查看时通过文件读取获取

### Requirement: 文档音视频按范围读取

`file_read` SHALL 按真实文件类型处理文本、图片、PDF、Office、音频和视频，并明确返回页面、时间区间、抽样与截断范围。Office SHALL 使用配置的转换服务；音频 SHALL 使用配置的转写服务；视频 SHALL 使用 ffprobe/ffmpeg 提取所请求范围。

#### Scenario: 只读取视频的一段
- **WHEN** 用户指定时间区间读取视频
- **THEN** 系统返回该区间的画面和可用转写，并保留原文件时间戳，不声称覆盖整段视频

### Requirement: 媒体引用与权威数据

系统 SHALL 在工具结果中保存受控媒体引用，仅在构造模型请求时装载图片字节。观测快照与 trace SHALL 省略媒体字节，且不改写 step 权威响应。

#### Scenario: 管理员读取带图片的请求观测
- **WHEN** 请求包含图片输入
- **THEN** 观测记录提供媒体元信息而不包含图片字节，原始附件继续通过受控文件访问
