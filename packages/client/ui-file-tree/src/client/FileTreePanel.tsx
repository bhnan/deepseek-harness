/**
 * The workspace file tree filling the sidebar shell's `sidebar.filetree`
 * hole: a collapsible band rooted at the active session's Workspace (session
 * cwd fallback), loading each directory level lazily on expand through the
 * injected Host listing and opening files with the Host OS's default
 * application. No active workspace renders nothing at all — the band
 * collapses to zero height.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import clsx from 'clsx'
import {
  IconChevronRightOutline14, IconFolderClose16, IconFolderOpen16,
  IconRefreshOutline14, Modal, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { IconProps } from '@deepseek-ai/dsh-client-ui-primitives'
import type { FilePreview, FileTreeLevel, FileTreePanelProps } from './contract/slots.ts'
import css from './FileTreePanel.module.css'

/** Plain file glyph (local: ui-primitives carries no file icon yet). */
/* v8 ignore next 6 -- static glyph: the IconProps-parity default never evaluates (the file row pins 13px). */
const IconFile16 = ({ size = 16, className }: IconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none">
    <path d="M9.5 1H4.5C3.67157 1 3 1.67157 3 2.5V13.5C3 14.3284 3.67157 15 4.5 15H11.5C12.3284 15 13 14.3284 13 13.5V4.5L9.5 1Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    <path d="M9.5 1V4.5H13" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
  </svg>
)

/** Last path segment across POSIX and Windows separators. */
function baseNameOf(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  if (cut === -1) return trimmed
  /* v8 ignore next -- `|| trimmed` arm: the trailing-separator strip leaves a non-empty tail after `cut`. */
  return trimmed.slice(cut + 1) || trimmed
}

/** Human-readable byte size (preview footer). */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** The open preview dialog's state. */
type PreviewState = {
  path: string
  name: string
  state: 'loading' | 'ready' | 'error'
  data?: FilePreview
}

/** One cached level: its load state plus the level facts once ready. */
type LevelState = { state: 'loading' | 'ready' | 'error' } & FileTreeLevel

/** An unloaded/failed level placeholder (empty facts, state carries the truth). */
const emptyLevel = (state: LevelState['state']): LevelState =>
  ({ state, dirs: [], files: [], truncated: false })

/**
 * Render the workspace file-tree panel.
 * @param props - composed slot props (owner share + injected actions + locale).
 * @returns the panel element tree, or null without an active workspace root.
 */
export function FileTreePanel({ useSessions, useWorkspaces, listLevel, readFile, openPath, t }: FileTreePanelProps) {
  const current = useSessions(s => s.current)
  const currentCwd = useSessions(s => (s.current === undefined ? undefined : s.byId[s.current]?.cwd))
  const workspaces = useWorkspaces(s => s.items)

  // Root = the active session's Workspace path; a workspace-less session
  // falls back to its recorded cwd. No root → no panel.
  const root = useMemo(() => {
    if (current !== undefined) {
      const owner = workspaces.find(workspace => workspace.sessionIds.includes(current))
      if (owner !== undefined) return owner.path
    }
    return currentCwd
  }, [current, currentCwd, workspaces])

  const [open, setOpen] = useState(true)
  const [levels, setLevels] = useState<Record<string, LevelState>>({})
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [preview, setPreview] = useState<PreviewState | null>(null)
  const previewController = useRef<AbortController | null>(null)
  // Requested paths and their in-flight aborts live outside render state:
  // a level is fetched once per root lifetime unless explicitly retried.
  const requested = useRef(new Set<string>())
  const controllers = useRef(new Map<string, AbortController>())

  const abortAll = (): void => {
    for (const controller of controllers.current.values()) controller.abort()
    controllers.current.clear()
  }

  const ensureLevel = useCallback((path: string, retry = false): void => {
    if (requested.current.has(path)) {
      if (!retry) return
      /* v8 ignore next -- `?.` arm: paths and controllers are added and cleared together, so a retried path always holds a controller. */
      controllers.current.get(path)?.abort()
      controllers.current.delete(path)
      requested.current.delete(path)
    }
    requested.current.add(path)
    const controller = new AbortController()
    controllers.current.set(path, controller)
    setLevels(prev => ({ ...prev, [path]: emptyLevel('loading') }))
    listLevel(path, controller.signal).then(
      (level) => {
        if (controller.signal.aborted) return
        setLevels(prev => ({ ...prev, [path]: { state: 'ready', ...level } }))
      },
      () => {
        if (controller.signal.aborted) return
        setLevels(prev => ({ ...prev, [path]: emptyLevel('error') }))
      },
    )
  }, [listLevel])

  // Root change is a hard reset: nothing cached under the old root applies.
  useEffect(() => {
    requested.current.clear()
    abortAll()
    setLevels({})
    setExpanded({})
  }, [root])
  useEffect(() => {
    if (open && root !== undefined) ensureLevel(root)
  }, [open, root, ensureLevel])
  // Departing panel: no fetch outlives it.
  useEffect(() => () => {
    abortAll()
    previewController.current?.abort()
  }, [])

  if (root === undefined) return null

  const openPreview = (path: string, name: string): void => {
    previewController.current?.abort()
    const controller = new AbortController()
    previewController.current = controller
    setPreview({ path, name, state: 'loading' })
    readFile(path, controller.signal).then(
      (data) => {
        if (controller.signal.aborted) return
        setPreview({ path, name, state: 'ready', data })
      },
      () => {
        if (controller.signal.aborted) return
        setPreview({ path, name, state: 'error' })
      },
    )
  }
  const closePreview = (): void => {
    /* v8 ignore next -- `?.` arm: the dialog only closes after openPreview installed a controller. */
    previewController.current?.abort()
    setPreview(null)
  }

  const refresh = (): void => {
    requested.current.clear()
    abortAll()
    setLevels({})
    ensureLevel(root)
  }

  const renderLevel = (path: string, depth: number): ReactNode => {
    const level = levels[path] ?? emptyLevel('loading')
    const indent = { paddingLeft: 8 + depth * 14 }
    if (level.state === 'loading') {
      return <div className={css.hint} style={indent}>{t('loading')}</div>
    }
    if (level.state === 'error') {
      return (
        <button type="button" className={clsx(css.hint, css.error)} style={indent} onClick={() => { ensureLevel(path, true) }}>
          {t('error')}
        </button>
      )
    }
    if (level.dirs.length === 0 && level.files.length === 0) {
      return <div className={css.hint} style={indent}>{t('empty')}</div>
    }
    return (
      <>
        {level.dirs.map((dir) => {
          const isOpen = expanded[dir.path] === true
          return (
            <div key={dir.path}>
              <button
                type="button"
                className={clsx(css.row, dir.hidden && css.dimmed)}
                style={indent}
                title={dir.path}
                onClick={() => {
                  setExpanded(prev => ({ ...prev, [dir.path]: !isOpen }))
                  if (!isOpen) ensureLevel(dir.path)
                }}
              >
                <IconChevronRightOutline14 className={clsx(css.chevron, isOpen && css.chevronOpen)} size={12} />
                {isOpen ? <IconFolderOpen16 className={css.rowIcon} size={14} /> : <IconFolderClose16 className={css.rowIcon} size={14} />}
                <span className={css.rowLabel}>{dir.name}</span>
              </button>
              {isOpen && renderLevel(dir.path, depth + 1)}
            </div>
          )
        })}
        {level.files.map(file => (
          <button
            key={file.path}
            type="button"
            className={clsx(css.row, file.hidden && css.dimmed)}
            style={{ paddingLeft: 8 + depth * 14 + 16 }}
            title={file.path}
            onClick={() => { openPreview(file.path, file.name) }}
          >
            <IconFile16 className={css.rowIcon} size={13} />
            <span className={css.rowLabel}>{file.name}</span>
          </button>
        ))}
        {level.truncated && <div className={css.hint} style={indent}>{t('truncated')}</div>}
      </>
    )
  }

  return (
    <div className={css.root}>
      <div className={css.header}>
        <button
          type="button"
          className={css.headerToggle}
          aria-label={open ? t('collapse') : t('expand')}
          onClick={() => { setOpen(value => !value) }}
        >
          <IconChevronRightOutline14 className={clsx(css.chevron, open && css.chevronOpen)} size={12} />
          <span className={css.headerTitle}>{t('section.title')}</span>
          <span className={css.headerPath} title={root}>{baseNameOf(root)}</span>
        </button>
        <Tooltip label={t('refresh')} delayMs={500}>
          <button type="button" className={css.iconButton} aria-label={t('refresh')} onClick={refresh}>
            <IconRefreshOutline14 size={13} />
          </button>
        </Tooltip>
      </div>
      {open && <div className={css.tree}>{renderLevel(root, 0)}</div>}
      <Modal
        open={preview !== null}
        onClose={closePreview}
        title={preview?.name ?? ''}
        closeLabel={t('preview.close')}
        className={clsx(css.previewDialog)}
        contentClassName={clsx(css.previewContent)}
        footer={(
          <div className={css.previewFooter}>
            <span className={css.previewMeta}>
              {preview?.data !== undefined && formatSize(preview.data.size)}
              {preview?.data?.truncated === true && ` · ${t('preview.truncated')}`}
            </span>
            <button
              type="button"
              className={css.previewExternal}
              /* v8 ignore next -- narrowing guard: the footer is only clickable while the dialog is open. */
              onClick={() => { if (preview !== null) openPath(preview.path) }}
            >
              {t('preview.openExternal')}
            </button>
          </div>
        )}
      >
        {preview?.state === 'loading' && <div className={css.previewHint}>{t('preview.loading')}</div>}
        {preview?.state === 'error' && <div className={clsx(css.previewHint, css.error)}>{t('preview.error')}</div>}
        {preview?.state === 'ready'
        /* v8 ignore next -- narrowing guard: a ready preview always carries its data. */
        && preview.data !== undefined && (
          preview.data.kind === 'text'
            ? <pre className={css.previewText}>{preview.data.content}</pre>
            : preview.data.kind === 'image'
              ? <img className={css.previewImage} src={`data:${preview.data.mime};base64,${preview.data.content}`} alt={preview.name} />
              : <div className={css.previewHint}>{t('preview.binary')}</div>
        )}
      </Modal>
    </div>
  )
}
