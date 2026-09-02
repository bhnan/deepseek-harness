// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, within } from '@testing-library/react'
import { FilePicker } from '../src/client/FilePicker.tsx'

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
  onFiles: (files: readonly File[]) => void | Promise<void>
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
    onFiles: vi.fn<FilePickerProps['onFiles']>(),
    ...overrides,
  }
}

class TestFileList implements FileList {
  [index: number]: File
  readonly length: number
  private readonly files: readonly File[]

  constructor(files: readonly File[]) {
    this.files = files
    this.length = files.length
    files.forEach((file, index) => { this[index] = file })
  }

  item(index: number): File | null {
    return this[index] ?? null
  }

  [Symbol.iterator](): ArrayIterator<File> {
    return this.files[Symbol.iterator]()
  }
}

function inputFor(container: HTMLElement, kind: 'file' | 'photos'): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>(`input[data-file-picker-kind="${kind}"]`)
  if (input === null) throw new Error(`missing ${kind} file picker input`)
  return input
}

function isImageOnlyAccept(accept: string | null): boolean {
  const acceptedTypes = (accept ?? '').split(',').map(type => type.trim()).filter(Boolean)
  return acceptedTypes.length > 0
    && acceptedTypes.every(type => type.toLowerCase().startsWith('image/'))
}

describe('FilePicker', () => {
  it('opens an accessible attachment dialog from its button', () => {
    const view = render(<FilePicker {...props()} />)

    fireEvent.click(view.getByRole('button', { name: 'Upload attachment' }))

    expect(view.getByRole('dialog', { name: 'Upload attachment' })).toBeTruthy()
  })

  it('opens the general file chooser with a non-image-only multiple input', () => {
    const view = render(<FilePicker {...props()} />)
    fireEvent.click(view.getByRole('button', { name: labels.button }))
    const dialog = view.getByRole('dialog', { name: labels.dialog })

    expect(within(dialog).getByRole('button', { name: labels.chooseFile })).toBeTruthy()
    expect(within(dialog).getByRole('button', { name: labels.choosePhotos })).toBeTruthy()

    fireEvent.click(within(dialog).getByRole('button', { name: labels.chooseFile }))
    const fileInput = inputFor(dialog, 'file')
    expect(fileInput.type).toBe('file')
    expect(fileInput.multiple).toBe(true)
    expect(isImageOnlyAccept(fileInput.getAttribute('accept'))).toBe(false)
  })

  it('forwards selected files to onFiles in FileList order', () => {
    const onFiles = vi.fn<FilePickerProps['onFiles']>()
    const view = render(<FilePicker {...props({ onFiles })} />)
    fireEvent.click(view.getByRole('button', { name: labels.button }))
    const dialog = view.getByRole('dialog', { name: labels.dialog })
    fireEvent.click(within(dialog).getByRole('button', { name: labels.chooseFile }))
    const input = inputFor(dialog, 'file')
    const zeta = new File(['zeta'], 'zeta.md', { type: 'text/markdown' })
    const alpha = new File(['alpha'], 'alpha.zip', { type: 'application/zip' })

    fireEvent.change(input, { target: { files: new TestFileList([zeta, alpha]) } })

    expect(onFiles).toHaveBeenCalledWith([zeta, alpha])
  })

  it('opens the photo chooser and forwards selected photos in FileList order', () => {
    const onFiles = vi.fn<FilePickerProps['onFiles']>(async () => {})
    const view = render(<FilePicker {...props({ onFiles })} />)
    fireEvent.click(view.getByRole('button', { name: labels.button }))
    const dialog = view.getByRole('dialog', { name: labels.dialog })

    fireEvent.click(within(dialog).getByRole('button', { name: labels.choosePhotos }))
    const photosInput = inputFor(dialog, 'photos')
    expect(photosInput.type).toBe('file')
    expect(photosInput.multiple).toBe(true)
    expect(photosInput.accept).toBe('image/*')
    const zeta = new File(['zeta'], 'zeta.jpg', { type: 'image/jpeg' })
    const alpha = new File(['alpha'], 'alpha.png', { type: 'image/png' })

    fireEvent.change(photosInput, { target: { files: new TestFileList([zeta, alpha]) } })

    expect(onFiles).toHaveBeenCalledWith([zeta, alpha])
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
    const trigger = view.getByRole('button', { name: labels.button })
    if (!(trigger instanceof HTMLButtonElement)) throw new Error('attachment trigger is not a button')
    expect(trigger.disabled).toBe(true)

    fireEvent.click(trigger)

    expect(view.queryByRole('dialog', { name: labels.dialog })).toBeNull()
  })

  it('clears the input after selection so the same file can be selected again', () => {
    const onFiles = vi.fn<FilePickerProps['onFiles']>()
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

    fireEvent.change(input, { target: { files: new TestFileList([file]) } })
    expect(input.value).toBe('')

    fireEvent.change(input, { target: { files: new TestFileList([file]) } })
    expect(onFiles).toHaveBeenCalledTimes(2)
  })
})
