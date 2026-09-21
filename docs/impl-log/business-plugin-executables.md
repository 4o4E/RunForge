# 业务插件命令与依赖实施记录

## 2026-09-21

- Manifest 支持 `dependencies` 和 `executables`。当前执行目标固定为 Linux amd64。
- 安装归档时在暂存目录统一设置 `skills/**/scripts` 与声明命令为 `0755`，重新加载和旧 run 恢复不修改部署文件。
- 运行时为声明命令建立精确命令门面：普通 shell 使用 run 级临时目录，bwrap 使用 `/runforge/plugin-bin/<name>` 只读投射；不把可执行文件所在目录整体加入 `PATH`。
- `plugin_lock.plugins` 保留空间配置顺序。必需依赖自动按依赖优先顺序写入空间和运行锁；可选依赖只在管理员显式选择时启用。同名命令安装时返回警告，运行时采用空间顺序中的第一个声明。
- 新增可版本控制的 `plugins/business/audio-video-tools` 和 `plugins/business/bilibili-video-analysis` 源目录。B 站插件依赖通用音视频插件，运行时使用 `bbdown`、`ffmpeg` 和 `ffprobe`，不再解压嵌套归档。
- 音视频插件发布脚本固定使用 BtbN/FFmpeg-Builds 的 Linux amd64 GPL 版本和 SHA-256，发布阶段校验动态依赖后再生成外层 TGZ。运行任务不下载或解压工具。
- 静态音视频制品使归档限制调整为 150 MiB、解压总量 500 MiB、单文件 300 MiB；路径、symlink、硬链接和特殊文件限制不变。
