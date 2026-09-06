// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { FilePicker } from '../src/client/FilePicker.tsx'

const labels = {
  button: '添加附件',
  dialog: '选择附件',
  chooseFile: '选择文件',
  choosePhotos: '选择照片',
  cancel: '取消',
  uploading: '上传中…',
}

afterEach(cleanup)

describe('FilePicker', () => {
  it('opens an accessible chooser with file and photo actions', () => {
    render(<FilePicker disabled={false} labels={labels} onFiles={() => {}} />)

    fireEvent.click(screen.getByRole('button', { name: labels.button }))
    const dialog = screen.getByRole('dialog', { name: labels.dialog })
    expect(within(dialog).getByRole('button', { name: labels.chooseFile })).toBeTruthy()
    expect(within(dialog).getByRole('button', { name: labels.choosePhotos })).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: labels.cancel }))
    expect(screen.queryByRole('dialog', { name: labels.dialog })).toBeNull()
  })

  it('passes native file selections through and clears the input for re-selection', () => {
    const onFiles = vi.fn()
    render(<FilePicker disabled={false} labels={labels} onFiles={onFiles} />)
    fireEvent.click(screen.getByRole('button', { name: labels.button }))
    const input = screen.getByTestId('file-picker-input-file') as HTMLInputElement
    const file = new File(['hello'], 'notes.txt', { type: 'text/plain' })
    fireEvent.change(input, { target: { files: [file] } })
    expect(onFiles).toHaveBeenCalledWith([file])
    expect(input.value).toBe('')
  })

  it('closes on Escape and restores focus to the trigger', () => {
    render(<FilePicker disabled={false} labels={labels} onFiles={() => {}} />)
    const trigger = screen.getByRole('button', { name: labels.button })
    fireEvent.click(trigger)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: labels.dialog })).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })
})
