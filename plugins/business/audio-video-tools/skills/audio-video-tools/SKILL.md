---
name: audio-video-tools
description: 使用 ffmpeg、ffprobe 和 Speaches 解析、转码、抽帧并转写各来源的音视频文件。
---

当前运行环境只支持 Linux amd64。使用 `ffprobe` 获取媒体格式、编码、时长和流信息，使用 `ffmpeg` 完成音频提取和必要的转码。以下 `<root>` 是激活结果提供的本 Skill 根目录：

- 语音转写：`node <root>/scripts/transcribe.mjs <音频路径> <输出.srt> [语言]`，语言默认 `zh`。脚本会把音频压缩后交给 Speaches，并输出标准 SRT；空文件表示没有识别到有效讲话。
- 均匀抽帧或指定时间抽帧：`node <root>/scripts/frames.mjs <视频路径> <输出目录> [秒数CSV]`。脚本输出 `frames.json`，其中包含每张图片的秒数和路径。

输入文件、中间文件和结果必须写入当前会话工作目录；不要下载或安装其他版本的媒体工具。
