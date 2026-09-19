export interface MessageAttachmentToken {
  kind?: string;
  path: string;
  name?: string;
  size?: number;
}

export interface SerializableAttachment {
  kind: 'remote' | 'local' | 'shell';
  path: string;
  name: string;
  size?: number;
  text?: string;
}

export function attachmentToken(attachment: SerializableAttachment): string {
  if (attachment.kind === 'shell') {
    return attachment.text ?? `用户标记了 shell 交互：${attachment.name}`;
  }
  const payload = {
    kind: attachment.kind,
    path: attachment.path,
    name: attachment.name,
    ...(attachment.size != null ? { size: attachment.size } : {}),
  };
  return `[[file:${JSON.stringify(payload)}]]`;
}

export function parseFileTokens(text: string): { text: string; files: MessageAttachmentToken[] } {
  const files: MessageAttachmentToken[] = [];
  let clean = '';
  let lastIndex = 0;
  const tokenRe = /\[\[file:(\{.*?\})\]\]/g;

  for (const match of text.matchAll(tokenRe)) {
    clean += text.slice(lastIndex, match.index);
    lastIndex = (match.index ?? 0) + match[0].length;
    try {
      const data = JSON.parse(match[1]) as Partial<MessageAttachmentToken>;
      if (typeof data.path === 'string' && data.path.trim()) files.push(data as MessageAttachmentToken);
      else clean += match[0];
    } catch {
      clean += match[0];
    }
  }
  clean += text.slice(lastIndex);

  return { text: clean.replace(/\n{3,}/g, '\n\n').trimEnd(), files };
}
