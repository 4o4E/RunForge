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

export interface RemoteFileInfo {
  workspaceRoot: string;
  rootPath: string;
}
