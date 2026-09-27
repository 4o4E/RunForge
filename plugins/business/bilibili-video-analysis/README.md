# B 站视频分析业务插件

插件只支持 Linux amd64，只包含 B 站链接解析、BBDown 下载、元数据和评论处理。它依赖 `audio-video-tools` 提供 `ffmpeg`、`ffprobe`、关键帧抽取和 Speaches 转写，不再声明 Speaches Secret。本插件包直接包含 BBDown 可执行文件，不在运行任务中下载、解压或修改权限，最终由 RunForge Agent 进行分析。

事实核验只搜索会影响视频核心结论且存在争议、显著影响判断或明显可能造成误导的关键主张。延伸搜索只用于补足理解视频所必需的关键背景；其他核验和延伸数组保持为空。来源保存在结构化结果的 `sources` 字段供调用方核验，不放入用户可见的正文。

发布前执行 `scripts/package-linux-amd64.sh <staging-directory>` 生成外层 TGZ。`bin/linux-amd64/BBDown` 必须已经存在；禁止在插件包内继续嵌套 ZIP、TGZ 或其他归档。
