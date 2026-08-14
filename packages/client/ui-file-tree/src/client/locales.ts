/** `filetree` namespace dictionaries: the workspace file-tree panel's copy. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'section.title': '文件',
  'loading': '加载中…',
  'empty': '空目录',
  'error': '读取失败，点击重试',
  'truncated': '条目过多，仅显示开头部分',
  'refresh': '刷新',
  'collapse': '收起文件树',
  'expand': '展开文件树',
  'preview.loading': '读取中…',
  'preview.error': '读取失败',
  'preview.binary': '该文件不支持预览',
  'preview.truncated': '文件过大，仅显示开头部分',
  'preview.openExternal': '用系统应用打开',
  'preview.close': '关闭预览',
} satisfies Record<string, string>

/** The filetree namespace key union. */
export type FileTreeKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'section.title': 'Files',
  'loading': 'Loading…',
  'empty': 'Empty directory',
  'error': 'Failed to read; click to retry',
  'truncated': 'Too many entries; only the beginning is shown',
  'refresh': 'Refresh',
  'collapse': 'Collapse file tree',
  'expand': 'Expand file tree',
  'preview.loading': 'Reading…',
  'preview.error': 'Failed to read',
  'preview.binary': 'This file cannot be previewed',
  'preview.truncated': 'File too large; only the beginning is shown',
  'preview.openExternal': 'Open with system app',
  'preview.close': 'Close preview',
} satisfies Record<FileTreeKey, string>
