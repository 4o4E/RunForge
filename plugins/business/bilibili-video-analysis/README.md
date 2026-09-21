# B 站视频分析业务插件

插件只支持 Linux amd64，只包含 B 站链接解析、BBDown 下载、元数据和评论处理。它依赖 `audio-video-tools` 提供 `ffmpeg`、`ffprobe`、关键帧抽取和 Speaches 转写，不再声明 Speaches Secret。本插件包直接包含 BBDown 可执行文件，不在运行任务中下载、解压或修改权限，最终由 RunForge Agent 进行分析。

发布前执行 `scripts/package-linux-amd64.sh <staging-directory>` 生成外层 TGZ。`bin/linux-amd64/BBDown` 必须已经存在；禁止在插件包内继续嵌套 ZIP、TGZ 或其他归档。
