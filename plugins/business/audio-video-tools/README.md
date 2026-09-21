# 通用音视频文件解析业务插件

插件只支持 Linux amd64，提供 `ffmpeg`、`ffprobe` 和基于 Speaches 的通用语音转写。租户需要配置 `audio-video-tools.speaches-url` 与 `audio-video-tools.speaches-key`。

发布前执行 `scripts/package-linux-amd64.sh <staging-directory>`，脚本固定使用 [BtbN/FFmpeg-Builds autobuild-2026-09-20-13-11](https://github.com/BtbN/FFmpeg-Builds/releases/tag/autobuild-2026-09-20-13-11) 的 `ffmpeg-n9.0.2-3-ga5923073bf-linux64-gpl-9.0.tar.xz`，并校验上游 `checksums.sha256` 中的 SHA-256 `7569c7c00a421d4fb4636925a126e96e051bb5cdd0b0e0a91576ddfadddd9bff`。脚本会拒绝缺失依赖或依赖外部 libav/codec 库的文件，把 `ffmpeg` 和 `ffprobe` 直接写入插件目录后生成外层 TGZ。上传的插件包中不允许再嵌套 ZIP 或其他压缩包。

B 站视频分析插件通过业务插件依赖声明使用本插件；其他视频来源插件可以复用相同的 Skill 和命令。
