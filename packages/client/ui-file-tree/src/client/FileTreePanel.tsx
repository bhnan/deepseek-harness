import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import clsx from 'clsx'
import { IconChevronRightOutline14, IconFolderClose16, IconFolderOpen16, IconRefreshOutline14, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { FileTreePanelProps } from './contract/slots.ts'
import css from './FileTreePanel.module.css'

type Preview = { path: string; name: string; state: 'loading' | 'ready' | 'error'; data?: Awaited<ReturnType<FileTreePanelProps['readFile']>> }
type Level = { state: 'loading' | 'ready' | 'error'; dirs: Awaited<ReturnType<FileTreePanelProps['listLevel']>>['dirs']; files: Awaited<ReturnType<FileTreePanelProps['listLevel']>>['files']; dirsTruncated: boolean; filesTruncated: boolean }
const empty = (state: Level['state']): Level => ({ state, dirs: [], files: [], dirsTruncated: false, filesTruncated: false })
function sizeOf(bytes: number): string { return bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB` }

export function FileTreePanel({ wide, useSessions, useWorkspaces, listLevel, readFile, openPath, t }: FileTreePanelProps) {
  const current = useSessions(s => s.current)
  const cwd = useSessions(s => s.current === undefined ? undefined : s.byId[s.current]?.cwd)
  const workspaces = useWorkspaces(s => s.items)
  const root = useMemo(
    () => workspaces.find(workspace => current !== undefined && workspace.sessionIds.includes(current))?.path ?? cwd,
    [current, cwd, workspaces],
  )
  const [levels, setLevels] = useState<Record<string, Level>>({})
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [preview, setPreview] = useState<Preview | null>(null)
  const controllers = useRef(new Map<string, AbortController>())
  const requested = useRef(new Set<string>())

  useEffect(() => {
    for (const controller of controllers.current.values()) {
      controller.abort()
    }
    controllers.current.clear()
    requested.current.clear()
    setLevels({})
    setExpanded({})
  }, [root])

  useEffect(() => () => {
    for (const controller of controllers.current.values()) {
      controller.abort()
    }
  }, [])

  if (!wide || root === undefined) return null

  const load = (path: string, retry = false): void => {
    if (requested.current.has(path) && !retry) return
    controllers.current.get(path)?.abort()
    requested.current.add(path)
    const controller = new AbortController()
    controllers.current.set(path, controller)
    setLevels(prev => ({ ...prev, [path]: empty('loading') }))
    listLevel(path, controller.signal).then(
      (value) => {
        if (!controller.signal.aborted) {
          setLevels(prev => ({ ...prev, [path]: { state: 'ready', ...value } }))
        }
      },
      () => {
        if (!controller.signal.aborted) {
          setLevels(prev => ({ ...prev, [path]: empty('error') }))
        }
      },
    )
  }

  if (!requested.current.has(root)) load(root)

  const showPreview = (path: string, name: string): void => {
    setPreview({ path, name, state: 'loading' })
    const controller = new AbortController()
    readFile(path, controller.signal).then(
      (data) => {
        setPreview({ path, name, state: 'ready', data })
      },
      () => {
        setPreview({ path, name, state: 'error' })
      },
    )
  }

  const render = (path: string, depth: number): ReactNode => {
    const level = levels[path] ?? empty('loading')
    const indent = { paddingLeft: 6 + depth * 12 }

    if (level.state === 'loading') {
      return <div className={css.hint} style={indent}>{t('loading')}</div>
    }

    if (level.state === 'error') {
      return (
        <button className={css.hint} style={indent} onClick={() => { load(path, true) }}>
          {t('error')}
        </button>
      )
    }

    return (
      <>
        {level.dirs.map((dir) => {
          const open = expanded[dir.path] === true
          return (
            <div key={dir.path}>
              <button
                className={clsx(css.row, dir.hidden && css.dim)}
                style={indent}
                onClick={() => {
                  setExpanded(prev => ({ ...prev, [dir.path]: !open }))
                  if (!open) load(dir.path)
                }}
              >
                <span className={clsx(css.chevron, open && css.open)}>
                  <IconChevronRightOutline14 size={12} />
                </span>
                {open ? <IconFolderOpen16 size={14} /> : <IconFolderClose16 size={14} />}
                <span>{dir.name}</span>
              </button>
              {open && render(dir.path, depth + 1)}
            </div>
          )
        })}
        {level.files.map(file => (
          <button
            key={file.path}
            className={clsx(css.row, file.hidden && css.dim)}
            style={{ paddingLeft: 22 + depth * 12 }}
            onClick={() => { showPreview(file.path, file.name) }}
          >
            <span>📄</span>
            <span>{file.name}</span>
          </button>
        ))}
        {(level.dirsTruncated || level.filesTruncated) && <div className={css.hint} style={indent}>…</div>}
      </>
    )
  }

  return (
    <div className={css.root}>
      <div className={css.header}>
        <span>{t('section.title')}</span>
        <button
          className={css.refresh}
          onClick={() => {
            requested.current.clear()
            setLevels({})
            load(root, true)
          }}
          aria-label={t('refresh')}
        >
          <IconRefreshOutline14 size={13} />
        </button>
      </div>
      <div className={css.tree}>{render(root, 0)}</div>
      <Modal
        open={preview !== null}
        onClose={() => { setPreview(null) }}
        title={preview?.name ?? ''}
        closeLabel={t('preview.close')}
      >
        {preview?.state === 'loading' && <div>{t('preview.loading')}</div>}
        {preview?.state === 'error' && <div>{t('preview.error')}</div>}
        {preview?.state === 'ready' && preview.data !== undefined && (
          preview.data.kind === 'text'
            ? <pre className={css.preview}>{preview.data.content}</pre>
            : preview.data.kind === 'image'
              ? <img className={css.image} src={`data:${preview.data.mime};base64,${preview.data.content}`} alt={preview.name} />
              : <div>{t('preview.binary')}</div>
        )}
        {preview?.data !== undefined && (
          <button onClick={() => { openPath(preview.path) }}>
            {t('preview.openExternal')} · {sizeOf(preview.data.size)}
          </button>
        )}
      </Modal>
    </div>
  )
}
