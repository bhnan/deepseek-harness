import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import css from './FilePicker.module.css'

/** File-picker strings resolved by the owning composer. */
export interface FilePickerLabels {
  button: string
  dialog: string
  chooseFile: string
  choosePhotos: string
  cancel: string
  uploading: string
}

/** Controlled attachment-picker surface contract. */
export interface FilePickerProps {
  disabled: boolean
  labels: FilePickerLabels
  onFiles: (files: readonly File[]) => void | Promise<void>
}

type FilePickerKind = 'file' | 'photos'

/**
 * Small attachment trigger with native file inputs kept in the accessible
 * surface. The chooser buttons call the native input directly from their
 * click handlers so mobile browsers retain the user-gesture permission.
 */
export function FilePicker({ disabled, labels, onFiles }: FilePickerProps) {
  const [open, setOpen] = useState(false)
  const [uploading, setUploading] = useState(false)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const chooseFileRef = useRef<HTMLButtonElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const photosInputRef = useRef<HTMLInputElement | null>(null)

  const closePicker = useCallback((): void => {
    setOpen(false)
  }, [])

  const openPicker = (): void => {
    if (disabled) return
    setOpen(true)
  }

  const chooseInput = (kind: FilePickerKind): void => {
    if (uploading) return
    const input = kind === 'file' ? fileInputRef.current : photosInputRef.current
    input?.click()
  }

  const handleChange = useCallback((event: ChangeEvent<HTMLInputElement>): void => {
    const input = event.currentTarget
    const files = Array.from(input.files ?? [])

    // Clear before invoking the owner so the same browser selection can be
    // chosen again even when the upload takes time or rejects.
    input.value = ''
    if (files.length === 0) return

    let result: void | Promise<void>
    try {
      result = onFiles(files)
    } catch {
      // The owner normally reports upload failures; a synchronous throw is
      // consumed here for the same reason as an asynchronous rejection.
      return
    }
    if (result === undefined) return

    setUploading(true)
    void Promise.resolve(result)
      .catch(() => {
        // The owner surfaces the upload error; prevent an unhandled rejection.
      })
      .finally(() => {
        setUploading(false)
      })
  }, [onFiles])

  useEffect(() => {
    if (!open) return
    const restoreFocus = triggerRef.current
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      closePicker()
    }
    window.addEventListener('keydown', onKeyDown)
    if (chooseFileRef.current !== null && !chooseFileRef.current.disabled) {
      chooseFileRef.current.focus()
    } else {
      dialogRef.current?.focus()
    }
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      restoreFocus?.focus()
    }
  }, [closePicker, open])

  return (
    <div className={css.root}>
      <button
        ref={triggerRef}
        type="button"
        className={css.trigger}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={openPicker}
      >
        {labels.button}
      </button>
      {open && (
        <div
          ref={dialogRef}
          className={css.surface}
          role="dialog"
          aria-modal="true"
          aria-label={labels.dialog}
          aria-busy={uploading}
          tabIndex={-1}
        >
          <div className={css.actions}>
            <button
              ref={chooseFileRef}
              type="button"
              className={css.action}
              disabled={uploading}
              onClick={() => { chooseInput('file') }}
            >
              {labels.chooseFile}
            </button>
            <button
              type="button"
              className={css.action}
              disabled={uploading}
              onClick={() => { chooseInput('photos') }}
            >
              {labels.choosePhotos}
            </button>
            <button type="button" className={css.cancel} onClick={closePicker}>
              {labels.cancel}
            </button>
          </div>
          {uploading && (
            <div className={css.status} role="status" aria-live="polite">
              {labels.uploading}
            </div>
          )}
          <input
            ref={fileInputRef}
            className={css.visuallyHidden}
            data-file-picker-kind="file"
            type="file"
            multiple
            disabled={uploading}
            onChange={handleChange}
          />
          <input
            ref={photosInputRef}
            className={css.visuallyHidden}
            data-file-picker-kind="photos"
            type="file"
            accept="image/*"
            multiple
            disabled={uploading}
            onChange={handleChange}
          />
        </div>
      )}
    </div>
  )
}
