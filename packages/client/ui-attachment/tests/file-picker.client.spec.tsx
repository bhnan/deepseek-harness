// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, within } from '@testing-library/react'
import { FilePicker } from '../src/FilePicker.tsx'

afterEach(cleanup)

interface FilePickerLabels {
  button: string
  dialog: string
  chooseFile: string
  choosePhotos: string
  cancel: string
  uploading: string
}

interface FilePickerProps {
  disabled: boolean
  labels: FilePickerLabels
  onFiles: (files: File[]) => void
}

const labels: FilePickerLabels = {
  button: 'Upload attachment',
  dialog: 'Upload attachment',
  chooseFile: 'Choose file',
  choosePhotos: 'Choose photos',
  cancel: 'Cancel',
  uploading: 'Uploading',
}

function props(overrides: Partial<FilePickerProps> = {}): FilePickerProps {
  return {
    disabled: false,
    labels,
    onFiles: vi.fn(),
    ...overrides,
  }
}

function asFileList(files: readonly File[]): FileList {
  const list = [...files] as File[] & { item(index: number): File | null }
  list.item = index => list[index] ?? null
  return list as unknown as FileList
}

function inputFor(container: HTMLElement, kind: 'file' | 'photos'): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>(`input[data-file-picker-kind="${kind}"]`)
  if (input === null) throw new Error(`missing ${kind} file picker input`)
  return input
}

describe('FilePicker', () => {
  it('opens an accessible attachment dialog from its button', () => {
    const view = render(<FilePicker {...props()} />)

    fireEvent.click(view.getByRole('button', { name: 'Upload attachment' }))

    expect(view.getByRole('dialog', { name: 'Upload attachment' })).toBeTruthy()
  })

  it('offers general files and photos as separate multiple inputs', () => {
    const view = render(<FilePicker {...props()} />)
    fireEvent.click(view.getByRole('button', { name: labels.button }))
    const dialog = view.getByRole('dialog', { name: labels.dialog })

    expect(within(dialog).getByRole('button', { name: labels.chooseFile })).toBeTruthy()
    expect(within(dialog).getByRole('button', { name: labels.choosePhotos })).toBeTruthy()

    const fileInput = inputFor(dialog, 'file')
    expect(fileInput.multiple).toBe(true)
    const acceptedFileTypes = fileInput.accept.split(',').map(type => type.trim()).filter(Boolean)
    const acceptsOnlyImages = acceptedFileTypes.length > 0
      && acceptedFileTypes.every(type => type.toLowerCase().startsWith('image/'))
    expect(acceptsOnlyImages).toBe(false)

    const photosInput = inputFor(dialog, 'photos')
    expect(photosInput.multiple).toBe(true)
    expect(photosInput.accept).toBe('image/*')
  })

  it('forwards selected files to onFiles in FileList order', () => {
    const onFiles = vi.fn()
    const view = render(<FilePicker {...props({ onFiles })} />)
    fireEvent.click(view.getByRole('button', { name: labels.button }))
    const input = inputFor(view.getByRole('dialog', { name: labels.dialog }), 'file')
    const files = [
      new File(['first'], 'first.md', { type: 'text/markdown' }),
      new File(['second'], 'second.png', { type: 'image/png' }),
      new File(['third'], 'third.zip', { type: 'application/zip' }),
    ]

    fireEvent.change(input, { target: { files: asFileList(files) } })

    expect(onFiles).toHaveBeenCalledWith(files)
  })

  it('closes when Cancel is pressed', () => {
    const view = render(<FilePicker {...props()} />)
    fireEvent.click(view.getByRole('button', { name: labels.button }))

    fireEvent.click(within(view.getByRole('dialog', { name: labels.dialog })).getByRole('button', {
      name: labels.cancel,
    }))

    expect(view.queryByRole('dialog', { name: labels.dialog })).toBeNull()
  })

  it('closes on Escape', () => {
    const view = render(<FilePicker {...props()} />)
    fireEvent.click(view.getByRole('button', { name: labels.button }))

    fireEvent.keyDown(view.getByRole('dialog', { name: labels.dialog }), { key: 'Escape' })

    expect(view.queryByRole('dialog', { name: labels.dialog })).toBeNull()
  })

  it('does not open when disabled', () => {
    const view = render(<FilePicker {...props({ disabled: true })} />)

    fireEvent.click(view.getByRole('button', { name: labels.button }))

    expect(view.queryByRole('dialog', { name: labels.dialog })).toBeNull()
  })

  it('clears the input after selection so the same file can be selected again', () => {
    const onFiles = vi.fn()
    const view = render(<FilePicker {...props({ onFiles })} />)
    fireEvent.click(view.getByRole('button', { name: labels.button }))
    const input = inputFor(view.getByRole('dialog', { name: labels.dialog }), 'file')
    const file = new File(['repeat'], 'repeat.txt', { type: 'text/plain' })
    let inputValue = 'C:\\fakepath\\repeat.txt'
    Object.defineProperty(input, 'value', {
      configurable: true,
      get: () => inputValue,
      set: (value: string) => { inputValue = value },
    })

    fireEvent.change(input, { target: { files: asFileList([file]) } })
    expect(input.value).toBe('')

    fireEvent.change(input, { target: { files: asFileList([file]) } })
    expect(onFiles).toHaveBeenCalledTimes(2)
  })
})
