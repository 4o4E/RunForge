import { extname } from 'node:path';

export const MAX_EXTERNAL_ARTIFACT_BYTES = 25 * 1024 * 1024;

export interface ExternalArtifactTokenSource {
  id: string;
  name: string;
  mimeType: string;
  size: number;
}

/**
 * artifact ID 保证跨调用唯一；原文件名只用于可读后缀，并收敛到短 ASCII 文件名，
 * 避免调用方名称变成路径、隐藏文件或超过常见文件系统的单段长度限制。
 */
export function externalArtifactRemotePath(artifact: Pick<ExternalArtifactTokenSource, 'id' | 'name'>): string {
  const normalized = artifact.name.normalize('NFKC').replace(/[^0-9A-Za-z._-]+/g, '-');
  const extension = extname(normalized).slice(0, 24);
  const stem = normalized.slice(0, Math.max(0, normalized.length - extension.length))
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 160) || 'file';
  return `uploads/${artifact.id}-${stem}${extension}`;
}

/** 使用现有 Web 文件 token 契约，让普通文件和图片沿用同一上下文装配链路。 */
export function attachExternalArtifactTokens(
  content: string,
  artifacts: readonly ExternalArtifactTokenSource[],
): string {
  if (!artifacts.length) return content;
  const tokens = artifacts.map((artifact) => `[[file:${JSON.stringify({
    kind: 'local',
    path: externalArtifactRemotePath(artifact),
    // 现有 file token 以 `]]` 结束；替换方括号可避免原文件名提前截断内部标记。
    name: artifact.name.replaceAll(']', '_'),
    mimeType: artifact.mimeType,
    size: artifact.size,
    artifactId: artifact.id,
  })}]]`);
  return `${content}\n\n${tokens.join('\n')}`;
}
