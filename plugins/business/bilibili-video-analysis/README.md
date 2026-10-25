# B 站视频分析业务插件

插件只支持 Linux amd64，包含 B 站链接解析、BBDown 下载、分区与视频信息读取，以及置顶和高赞评论整理。它依赖 `audio-video-tools` 提供 `ffmpeg`、`ffprobe`、关键帧抽取和 Speaches 转写，不再声明 Speaches Secret。本插件包直接包含 BBDown 可执行文件，不在运行任务中下载、解压或修改权限，最终由 RunForge Agent 进行分析。

Skill 提供视频信息、目标分 P 音轨、完整视频及置顶／高赞评论的获取方法，Agent 按当前问题选择资料，并复用通用音视频插件转写、探测和抽帧。QQ 原生视频及其他来源的已下载媒体直接使用通用音视频插件，不经过 B 站链接解析。

分析目标、处理顺序、详细程度、是否回复、来源展示及最终输出格式由空间和可信任务提示词决定。普通聊天可以针对讲话或画面使用自然语言回答；自动分析调用方可以要求先转写再分档，并返回用于绘制报告的 JSON。Skill 不声明固定的最终报告字段或静默条件。作者内容、评论观点与外部核验结论保持区分，所有结论以实际取得的证据为准。

在仓库根目录执行 `pnpm package:business-plugin bilibili-video-analysis`，生成并验证 `build/business-plugins/bilibili-video-analysis-<version>.zip`。`bin/linux-amd64/BBDown` 必须已经存在；媒体可执行文件直接包含在插件中，不嵌套压缩归档。更新后通过管理端导入完整插件包，新任务采用新版本，已有运行继续使用锁定快照。
