// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type {
  SessionId, SessionListState, WorkspaceId, WorkspaceListState, WorkspaceView,
} from '@deepseek-ai/dsh-client-runtime/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { FilePreview, FileTreeLevel, FileTreePanelProps } from '../src/client/contract/slots.ts'
import { FileTreePanel } from '../src/client/FileTreePanel.tsx'
import css from '../src/client/FileTreePanel.module.css'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

// Standard locale seat stub: the panel's own namespace, zh (the shipped copy).
const t: FileTreePanelProps['t'] = makeTranslate(zh)

const SID = 'session-1' as SessionId
const ROOT = '/ws/alpha'
const SRC = `${ROOT}/src`

/** Plain selector-hook stub over a fixed snapshot (the standard direct-props seat). */
function hook<T>(snapshot: T) {
  return function select<S>(selector: (state: T) => S): S { return selector(snapshot) }
}

function sessionState(opts: { current?: SessionId; cwd?: string; listed?: boolean } = {}): SessionListState {
  const { current, cwd, listed = true } = opts
  const byId: SessionListState['byId'] = {}
  if (current !== undefined && listed) {
    byId[current] = {
      id: current, displayTitle: 'Session', running: false, blank: false, updatedAt: 1,
      ...(cwd === undefined ? {} : { cwd }),
    }
  }
  return {
    ids: current === undefined ? [] : [current], byId, current, phase: 'ready',
    subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
  }
}

function workspace(id: string, path: string, sessionIds: SessionId[] = []): WorkspaceView {
  return {
    workspaceId: id as WorkspaceId, path, title: id, sessionIds,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

function workspaceState(items: readonly WorkspaceView[]): WorkspaceListState {
  return {
    items, archivedSessionIds: [], state: 'idle', phase: 'ready', error: null,
    baselinesReady: true, recentWorkspaceId: items[0]?.workspaceId,
  }
}

const rootLevel: FileTreeLevel = {
  dirs: [
    { name: 'src', path: SRC, hidden: false },
    { name: '.git', path: `${ROOT}/.git`, hidden: true },
  ],
  files: [
    { name: 'README.md', path: `${ROOT}/README.md`, hidden: false },
    { name: '.env', path: `${ROOT}/.env`, hidden: true },
  ],
  truncated: false,
}
const srcLevel: FileTreeLevel = {
  dirs: [],
  files: [{ name: 'main.ts', path: `${SRC}/main.ts`, hidden: false }],
  truncated: false,
}

function levelFor(path: string): FileTreeLevel {
  if (path === ROOT) return rootLevel
  if (path === SRC) return srcLevel
  throw new Error(`no listing for ${path}`)
}

/** Queue stub: every call hangs until the test settles it, its signal recorded. */
function gated<T>() {
  const calls: {
    path: string
    signal: AbortSignal | undefined
    resolve: (value: T) => void
    reject: (reason: unknown) => void
  }[] = []
  const fn = vi.fn((path: string, signal?: AbortSignal) =>
    new Promise<T>((resolve, reject) => { calls.push({ path, signal, resolve, reject }) }))
  return { fn, calls }
}

function mountPanel(opts: {
  sessions?: SessionListState
  workspaces?: WorkspaceListState
  listLevel?: FileTreePanelProps['listLevel']
  readFile?: FileTreePanelProps['readFile']
} = {}) {
  const listLevel = opts.listLevel ?? vi.fn(async (path: string) => levelFor(path))
  const readFile = opts.readFile ?? vi.fn(async (path: string): Promise<FilePreview> => ({
    size: 512, kind: 'text', content: `content of ${path}`, truncated: false,
  }))
  const openPath = vi.fn()
  let current = {
    sessions: opts.sessions ?? sessionState({ current: SID }),
    workspaces: opts.workspaces ?? workspaceState([workspace('alpha', ROOT, [SID])]),
  }
  const element = () => (
    <FileTreePanel
      wide
      useSessions={hook(current.sessions)}
      useWorkspaces={hook(current.workspaces)}
      listLevel={listLevel}
      readFile={readFile}
      openPath={openPath}
      t={t}
    />
  )
  const view = render(element())
  return {
    view, listLevel, readFile, openPath,
    rerender(next: Partial<typeof current>) {
      current = { ...current, ...next }
      view.rerender(element())
    },
  }
}

describe('FileTreePanel root resolution', () => {
  it('renders nothing without a current session', () => {
    const b = mountPanel({ sessions: sessionState({}), workspaces: workspaceState([]) })
    expect(b.view.container.firstChild).toBeNull()
    expect(b.listLevel).not.toHaveBeenCalled()
  })

  it('renders nothing when the session has neither a workspace nor a recorded cwd', () => {
    const b = mountPanel({
      sessions: sessionState({ current: SID, listed: false }),
      workspaces: workspaceState([workspace('beta', '/ws/beta')]),
    })
    expect(b.view.container.firstChild).toBeNull()
    expect(b.listLevel).not.toHaveBeenCalled()
  })

  it("roots at the active session's Workspace ahead of its recorded cwd", async () => {
    const b = mountPanel({
      sessions: sessionState({ current: SID, cwd: '/somewhere/else' }),
      workspaces: workspaceState([workspace('beta', '/ws/beta'), workspace('alpha', ROOT, [SID])]),
    })
    expect(screen.getByText('文件')).toBeTruthy()
    expect(screen.getByText('alpha')).toBeTruthy()
    expect(b.listLevel).toHaveBeenCalledWith(ROOT, expect.any(AbortSignal))
    await waitFor(() => { expect(screen.getByTitle(SRC)).toBeTruthy() })
  })

  it('falls back to the recorded session cwd when no Workspace owns the session', () => {
    const b = mountPanel({
      sessions: sessionState({ current: SID, cwd: '/home/solo/' }),
      workspaces: workspaceState([workspace('beta', '/ws/beta')]),
      listLevel: vi.fn(async () => ({ dirs: [], files: [], truncated: false })),
    })
    // The header label trims trailing separators; the listing keeps the raw path.
    expect(screen.getByText('solo')).toBeTruthy()
    expect(b.listLevel).toHaveBeenCalledWith('/home/solo/', expect.any(AbortSignal))
  })
})

describe('FileTreePanel levels', () => {
  it('shows loading until the level lands, then dirs before files with hidden rows dimmed', async () => {
    const gate = gated<FileTreeLevel>()
    const b = mountPanel({ listLevel: gate.fn })
    expect(screen.getByText('加载中…')).toBeTruthy()
    await act(async () => { gate.calls[0]!.resolve(rootLevel) })
    const rows = [...b.view.container.querySelectorAll('button[title]')]
    expect(rows.map(row => row.textContent)).toEqual(['src', '.git', 'README.md', '.env'])
    expect(screen.getByTitle(`${ROOT}/.git`).classList.contains(css.dimmed!)).toBe(true)
    expect(screen.getByTitle(SRC).classList.contains(css.dimmed!)).toBe(false)
    expect(screen.getByTitle(`${ROOT}/.env`).classList.contains(css.dimmed!)).toBe(true)
    expect(screen.getByTitle(`${ROOT}/README.md`).classList.contains(css.dimmed!)).toBe(false)
    expect(screen.queryByText('条目过多，仅显示开头部分')).toBeNull()
  })

  it('renders the empty hint for a childless level', async () => {
    mountPanel({ listLevel: vi.fn(async () => ({ dirs: [], files: [], truncated: false })) })
    await waitFor(() => { expect(screen.getByText('空目录')).toBeTruthy() })
  })

  it('marks a truncated level after its rows', async () => {
    mountPanel({ listLevel: vi.fn(async () => ({ ...rootLevel, truncated: true })) })
    await waitFor(() => { expect(screen.getByText('条目过多，仅显示开头部分')).toBeTruthy() })
    expect(screen.getByTitle(SRC)).toBeTruthy()
  })

  it('expands a directory lazily and keeps its level cached across collapse', async () => {
    const b = mountPanel()
    await waitFor(() => { expect(screen.getByTitle(SRC)).toBeTruthy() })
    fireEvent.click(screen.getByTitle(SRC))
    expect(b.listLevel).toHaveBeenCalledWith(SRC, expect.any(AbortSignal))
    expect(screen.getByText('加载中…')).toBeTruthy()
    await waitFor(() => { expect(screen.getByTitle(`${SRC}/main.ts`)).toBeTruthy() })
    fireEvent.click(screen.getByTitle(SRC))
    expect(screen.queryByTitle(`${SRC}/main.ts`)).toBeNull()
    fireEvent.click(screen.getByTitle(SRC))
    expect(screen.getByTitle(`${SRC}/main.ts`)).toBeTruthy()
    // Root and src listed exactly once each: re-expanding reads the cache.
    expect(b.listLevel).toHaveBeenCalledTimes(2)
  })

  it('offers retry on a failed level and reloads it', async () => {
    const gate = gated<FileTreeLevel>()
    const b = mountPanel({ listLevel: gate.fn })
    await act(async () => { gate.calls[0]!.reject(new Error('denied')) })
    fireEvent.click(screen.getByRole('button', { name: '读取失败，点击重试' }))
    expect(b.listLevel).toHaveBeenCalledTimes(2)
    expect(gate.calls[0]!.signal?.aborted).toBe(true)
    expect(screen.getByText('加载中…')).toBeTruthy()
    await act(async () => { gate.calls[1]!.resolve(rootLevel) })
    expect(screen.getByTitle(SRC)).toBeTruthy()
  })

  it('collapses and re-expands from the header without refetching', async () => {
    const b = mountPanel()
    await waitFor(() => { expect(screen.getByTitle(SRC)).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: '收起文件树' }))
    expect(screen.queryByTitle(SRC)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '展开文件树' }))
    expect(screen.getByTitle(SRC)).toBeTruthy()
    expect(b.listLevel).toHaveBeenCalledTimes(1)
  })

  it('refresh aborts the in-flight load, relists the root, and clears cached levels', async () => {
    const gate = gated<FileTreeLevel>()
    const b = mountPanel({ listLevel: gate.fn })
    // Refresh supersedes the still-pending first load; its late result is dropped.
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    expect(gate.calls[0]!.signal?.aborted).toBe(true)
    expect(b.listLevel).toHaveBeenCalledTimes(2)
    await act(async () => { gate.calls[0]!.resolve(rootLevel) })
    expect(screen.queryByTitle(SRC)).toBeNull()
    expect(screen.getByText('加载中…')).toBeTruthy()
    await act(async () => { gate.calls[1]!.resolve(rootLevel) })
    expect(screen.getByTitle(SRC)).toBeTruthy()
    // A refresh with an expanded child: the root relists, the child level is
    // dropped and stays un-refetched until its next expand.
    fireEvent.click(screen.getByTitle(SRC))
    await act(async () => { gate.calls[2]!.resolve(srcLevel) })
    expect(screen.getByTitle(`${SRC}/main.ts`)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    expect(gate.calls[2]!.signal?.aborted).toBe(true)
    await act(async () => { gate.calls[3]!.resolve(rootLevel) })
    expect(screen.getByTitle(SRC)).toBeTruthy()
    expect(screen.queryByTitle(`${SRC}/main.ts`)).toBeNull()
    expect(screen.getByText('加载中…')).toBeTruthy()
    expect(gate.fn.mock.calls.filter(([path]) => path === SRC)).toHaveLength(1)
  })

  it('a root change hard-resets the tree and drops superseded results', async () => {
    const gate = gated<FileTreeLevel>()
    const b = mountPanel({ listLevel: gate.fn })
    expect(screen.getByText('alpha')).toBeTruthy()
    // The session rebinds to a workspace-less cwd (separator-free: shown as-is).
    b.rerender({
      sessions: sessionState({ current: SID, cwd: 'plain-root' }),
      workspaces: workspaceState([]),
    })
    expect(gate.calls[0]!.signal?.aborted).toBe(true)
    expect(b.listLevel).toHaveBeenLastCalledWith('plain-root', expect.any(AbortSignal))
    expect(screen.getByText('plain-root')).toBeTruthy()
    // The old root's failure arrives late: nothing to show, nothing to retry.
    await act(async () => { gate.calls[0]!.reject(new Error('stale')) })
    expect(screen.queryByRole('button', { name: '读取失败，点击重试' })).toBeNull()
    expect(screen.getByText('加载中…')).toBeTruthy()
    await act(async () => {
      gate.calls[1]!.resolve({
        dirs: [], files: [{ name: 'notes.txt', path: 'plain-root/notes.txt', hidden: false }], truncated: false,
      })
    })
    expect(screen.getByTitle('plain-root/notes.txt')).toBeTruthy()
  })
})

describe('FileTreePanel preview', () => {
  it('opens a text preview, notes the truncation, and closes on Escape', async () => {
    const gate = gated<FilePreview>()
    const b = mountPanel({ readFile: gate.fn })
    await waitFor(() => { expect(screen.getByTitle(`${ROOT}/README.md`)).toBeTruthy() })
    fireEvent.click(screen.getByTitle(`${ROOT}/README.md`))
    expect(screen.getByRole('dialog').getAttribute('aria-label')).toBe('README.md')
    expect(screen.getByText('读取中…')).toBeTruthy()
    expect(b.readFile).toHaveBeenCalledWith(`${ROOT}/README.md`, expect.any(AbortSignal))
    await act(async () => { gate.calls[0]!.resolve({ size: 512, kind: 'text', content: '# 说明', truncated: true }) })
    expect(screen.getByText('# 说明')).toBeTruthy()
    expect(screen.getByRole('dialog').textContent).toContain('512 B · 文件过大，仅显示开头部分')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(gate.calls[0]!.signal?.aborted).toBe(true)
  })

  it('renders an image preview from the served bytes', async () => {
    const readFile = vi.fn(async (): Promise<FilePreview> => ({
      size: 2048, kind: 'image', content: 'QUJD', mime: 'image/png', truncated: false,
    }))
    mountPanel({ readFile })
    await waitFor(() => { expect(screen.getByTitle(`${ROOT}/README.md`)).toBeTruthy() })
    fireEvent.click(screen.getByTitle(`${ROOT}/README.md`))
    await waitFor(() => { expect(screen.getByAltText('README.md')).toBeTruthy() })
    expect(screen.getByAltText('README.md').getAttribute('src')).toBe('data:image/png;base64,QUJD')
    const footer = screen.getByRole('dialog').textContent
    expect(footer).toContain('2.0 KB')
    expect(footer).not.toContain('文件过大')
    fireEvent.click(screen.getByRole('button', { name: '关闭预览' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('reports an unpreviewable binary with its full size', async () => {
    const readFile = vi.fn(async (): Promise<FilePreview> => ({
      size: 3670016, kind: 'binary', truncated: false,
    }))
    mountPanel({ readFile })
    await waitFor(() => { expect(screen.getByTitle(`${ROOT}/README.md`)).toBeTruthy() })
    fireEvent.click(screen.getByTitle(`${ROOT}/README.md`))
    await waitFor(() => { expect(screen.getByText('该文件不支持预览')).toBeTruthy() })
    expect(screen.getByRole('dialog').textContent).toContain('3.5 MB')
  })

  it('shows the preview error state when the read fails', async () => {
    const readFile = vi.fn(async (): Promise<FilePreview> => { throw new Error('denied') })
    mountPanel({ readFile })
    await waitFor(() => { expect(screen.getByTitle(`${ROOT}/README.md`)).toBeTruthy() })
    fireEvent.click(screen.getByTitle(`${ROOT}/README.md`))
    await waitFor(() => { expect(screen.getByText('读取失败')).toBeTruthy() })
    expect(screen.getByRole('dialog').getAttribute('aria-label')).toBe('README.md')
  })

  it('hands the previewed file to the system opener', async () => {
    const b = mountPanel()
    await waitFor(() => { expect(screen.getByTitle(`${ROOT}/README.md`)).toBeTruthy() })
    fireEvent.click(screen.getByTitle(`${ROOT}/README.md`))
    await waitFor(() => { expect(screen.getByText(`content of ${ROOT}/README.md`)).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: '用系统应用打开' }))
    expect(b.openPath).toHaveBeenCalledWith(`${ROOT}/README.md`)
  })

  it('a second file click supersedes the pending read; closing drops a late failure', async () => {
    const gate = gated<FilePreview>()
    mountPanel({ readFile: gate.fn })
    await waitFor(() => { expect(screen.getByTitle(`${ROOT}/README.md`)).toBeTruthy() })
    fireEvent.click(screen.getByTitle(`${ROOT}/README.md`))
    fireEvent.click(screen.getByTitle(`${ROOT}/.env`))
    expect(gate.calls[0]!.signal?.aborted).toBe(true)
    expect(gate.calls[1]!.signal?.aborted).toBe(false)
    expect(screen.getByRole('dialog').getAttribute('aria-label')).toBe('.env')
    // The superseded read's late result must not clobber the new preview.
    await act(async () => { gate.calls[0]!.resolve({ size: 1, kind: 'text', content: 'stale', truncated: false }) })
    expect(screen.queryByText('stale')).toBeNull()
    expect(screen.getByText('读取中…')).toBeTruthy()
    await act(async () => { gate.calls[1]!.resolve({ size: 9, kind: 'text', content: 'fresh', truncated: false }) })
    expect(screen.getByText('fresh')).toBeTruthy()
    // Closing aborts the next read; its late failure stays silent.
    fireEvent.click(screen.getByTitle(`${ROOT}/README.md`))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(gate.calls[2]!.signal?.aborted).toBe(true)
    await act(async () => { gate.calls[2]!.reject(new Error('late')) })
    expect(screen.queryByText('读取失败')).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('unmount aborts the in-flight level and preview reads', async () => {
    const levelGate = gated<FileTreeLevel>()
    const readGate = gated<FilePreview>()
    const b = mountPanel({ listLevel: levelGate.fn, readFile: readGate.fn })
    await act(async () => { levelGate.calls[0]!.resolve(rootLevel) })
    fireEvent.click(screen.getByTitle(SRC))
    fireEvent.click(screen.getByTitle(`${ROOT}/README.md`))
    b.view.unmount()
    expect(levelGate.calls[1]!.signal?.aborted).toBe(true)
    expect(readGate.calls[0]!.signal?.aborted).toBe(true)
  })
})
