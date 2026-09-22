---
name: ai-image-generation
description: 根据文字生成图片，或结合当前会话中的参考图编辑图片。
---

需要生成或修改图片时使用本 Skill。先把请求写为当前工作目录中的 JSON 文件，再运行：

`node <root>/scripts/image.mjs <请求.json> <输出图片路径>`

`<root>` 是本 Skill 根目录。请求格式：

```json
{
  "mode": "generate",
  "prompt": "完整、明确的绘图要求",
  "model": "可选的空间图片模型 ID",
  "size": "可选尺寸"
}
```

编辑图片时使用 `"mode":"edit"`，并增加 `"images":["参考图1.png","参考图2.png"]`。
路径相对当前工作目录解析。图片来自聊天附件时，先通过调用方 Skill 下载到当前目录；不要把
临时 URL 写进请求。脚本成功后只输出生成文件的绝对路径。

生成后必须调用 `file_read` 检查实际图片是否符合要求。用户要求把图片发回调用方时，再按
调用方 Skill 的文件上传与发送流程操作。不要声称图片包含脚本未检查到的文字或细节。
