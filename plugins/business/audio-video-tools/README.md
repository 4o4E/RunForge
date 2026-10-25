# 通用音视频文件解析业务插件

插件只支持 Linux amd64，提供 `ffmpeg`、`ffprobe` 和基于 Speaches 的通用语音转写。租户需要配置 `audio-video-tools.speaches-url` 与 `audio-video-tools.speaches-key`。

发布前执行 `scripts/package-linux-amd64.sh <staging-directory>`，脚本固定使用 [BtbN/FFmpeg-Builds autobuild-2026-09-20-13-11](https://github.com/BtbN/FFmpeg-Builds/releases/tag/autobuild-2026-09-20-13-11) 的 `ffmpeg-n9.0.2-3-ga5923073bf-linux64-gpl-9.0.tar.xz`，并校验上游 `checksums.sha256` 中的 SHA-256 `7569c7c00a421d4fb4636925a126e96e051bb5cdd0b0e0a91576ddfadddd9bff`。脚本会拒绝缺失依赖或依赖外部 libav/codec 库的文件，把 `ffmpeg` 和 `ffprobe` 直接写入插件目录后生成外层 TGZ。上传的插件包中不允许再嵌套 ZIP 或其他压缩包。

B 站视频插件通过业务插件依赖声明使用本插件。QQ 原生视频和语音通过 QQ 能力物化／下载到会话目录；其他平台通过各自的平台能力或实际媒体直链取得原文件。取得文件后复用同一套媒体探测、转写和抽帧能力，不要求所有来源都通过 B 站下载器。

按任务所需证据选择处理步骤：讲话问题读取真实转写，视觉问题读取真实关键帧，无音轨或空转写不妨碍分析画面。处理范围、详细程度与最终回复格式由空间和可信任务提示词决定，Skill 不规定最终报告字段。

完整资源准备后，在仓库根目录执行 `pnpm package:business-plugin audio-video-tools --source <完整插件目录>`，生成并验证 `build/business-plugins/audio-video-tools-<version>.zip`。新任务采用管理员导入的新版本，已有运行继续使用锁定快照。
