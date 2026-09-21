# B 站视频分析业务插件

插件只支持 Linux amd64，依赖 `audio-video-tools` 提供的 `ffmpeg` 和 `ffprobe`。本插件包直接包含 BBDown 可执行文件，不在运行任务中下载、解压或修改权限。插件 Skill 负责获取视频元数据、真实音轨、关键帧和评论，最终由 RunForge Agent 进行分析。

上传前请把 `bin/linux-amd64/BBDown` 放入外层插件目录；禁止在插件包内继续嵌套 ZIP、TGZ 或其他归档。
