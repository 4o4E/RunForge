export interface RemoteFileEntry {
  name: string;
  path: string;
  type: 'dir' | 'file';
  size: number;
  updatedAt: string;
}

export interface RemoteFileList {
  path: string;
  parent: string | null;
  entries: RemoteFileEntry[];
}

export interface FilePreview {
  path: string;
  size: number;
  mode: 'full' | 'chunk';
  startLine: number;
  lines: string[];
  totalLines: number;
  nextLine: number | null;
  hasMore: boolean;
}

export interface FileTextVersion {
  size: number;
  mtimeMs: number;
  sha256: string;
}

export interface FileTextContent {
  path: string;
  content: string;
  version: FileTextVersion;
}

export interface FileTextSaveResponse {
  path: string;
  size: number;
  version: FileTextVersion;
}

export interface FileHexRow {
  offset: number;
  hex: string;
  ascii: string;
}

export interface FileHexPreview {
  path: string;
  size: number;
  offset: number;
  limit: number;
  rows: FileHexRow[];
  nextOffset: number | null;
  hasMore: boolean;
}

export interface RemoteFileInfo {
  workspaceRoot: string;
  rootPath: string;
}
