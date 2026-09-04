// @vitest-environment jsdom
/** Observable file-tree loading, bounded preview display, and external-open delegation. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { FileTreePanelProps } from '../src/client/contract/slots.ts'
import { FileTreePanel } from '../src/client/FileTreePanel.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const ROOT = '/tmp/workspace'
const FILE = `${ROOT}/notes.txt`
const FOLDER = `${ROOT}/nested`

/** Render props containing one active Session and its Workspace root. */
function props(overrides: Partial<FileTreePanelProps> = {}): FileTreePanelProps {
  const listLevel = vi.fn(async (path: string) => ({
    dirs: path === ROOT ? [{ name: 'nested', path: FOLDER, hidden: false }] : [],
    files: path === ROOT ? [{ name: 'notes.txt', path: FILE, hidden: false }] : [],
    dirsTruncated: false,
    filesTruncated: false,
  }))
  const readFile = vi.fn(async () => ({
    path: FILE,
    size: 12,
    kind: 'text' as const,
    content: 'bounded text',
    truncated: false,
  }))
  const openPath = vi.fn()
  return {
    wide: true,
    useSessions: ((selector: (state: unknown) => unknown) => selector({
      current: 'session-1',
      byId: { 'session-1': { cwd: ROOT } },
    })) as FileTreePanelProps['useSessions'],
    useWorkspaces: ((selector: (state: unknown) => unknown) => selector({
      items: [{ path: ROOT, sessionIds: ['session-1'] }],
    })) as FileTreePanelProps['useWorkspaces'],
    listLevel,
    readFile,
    openPath,
    t: ((key: keyof typeof en) => en[key]) as FileTreePanelProps['t'],
    ...overrides,
  } as FileTreePanelProps
}

describe('FileTreePanel', () => {
  it('loads the active Workspace root and lazily expands a directory', async () => {
    const view = props()
    render(<FileTreePanel {...view} />)

    await waitFor(() => { expect(view.listLevel).toHaveBeenCalledWith(ROOT, expect.any(AbortSignal)) })
    expect(await screen.findByRole('button', { name: /notes\.txt/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /nested/ }))
    await waitFor(() => { expect(view.listLevel).toHaveBeenCalledWith(FOLDER, expect.any(AbortSignal)) })
  })

  it('shows a bounded preview and delegates system opening to the injected Remote', async () => {
    const view = props()
    render(<FileTreePanel {...view} />)

    fireEvent.click(await screen.findByRole('button', { name: /notes\.txt/ }))
    expect(await screen.findByText('bounded text')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Open with system app/ }))
    expect(view.openPath).toHaveBeenCalledWith(FILE)
  })
})
