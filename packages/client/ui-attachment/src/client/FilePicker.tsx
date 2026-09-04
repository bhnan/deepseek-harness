import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChangeEvent, KeyboardEvent } from 'react'
import css from './FilePicker.module.css'

export interface FilePickerLabels {
  button: string
  dialog: string
  chooseFile: string
  choosePhotos: string
  cancel: string
  uploading: string
}

export interface FilePickerProps {
  disabled: boolean
  labels: FilePickerLabels
  onFiles: (files: readonly File[]) => void | Promise<void>
}

type FilePickerKind = 'file' | 'photos'

const FOCUSABLE_SELECTOR = 'button:not([disabled]), input:not([disabled]):not([type="hidden"]), [tabindex]:not([tabindex="-1"])'

function getFocusableElements(dialog: HTMLElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter(element => !element.hasAttribute('hidden') && element.tabIndex >= 0)
}

/** Mobile-safe attachment chooser that keeps native inputs behind a bottom sheet. */
export function FilePicker({ disabled, labels, onFiles }: FilePickerProps) {
  const [open, setOpen] = useState(false)
  const [uploading, setUploading] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const chooseFileRef = useRef<HTMLButtonElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const photosInputRef = useRef<HTMLInputElement>(null)

  const close = useCallback(() => { setOpen(false) }, [])
  const choose = (kind: FilePickerKind): void => {
    if (disabled || uploading) return
    ;(kind === 'file' ? fileInputRef : photosInputRef).current?.click()
  }
  const onChange = useCallback((event: ChangeEvent<HTMLInputElement>): void => {
    const input = event.currentTarget
    const files = Array.from(input.files ?? [])
    input.value = ''
    if (disabled || uploading || files.length === 0) return
    let result: void | Promise<void>
    try {
      result = onFiles(files)
    } catch {
      // The composer owns upload error presentation; keep the native picker closed.
      return
    }
    if (result === undefined) return
    setUploading(true)
    void Promise.resolve(result).catch(() => {
      // The composer owns upload error presentation; only release the busy state here.
    }).finally(() => { setUploading(false) })
  }, [disabled, onFiles, uploading])
  const onDialogKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Tab') return
    const dialog = dialogRef.current
    if (dialog === null) return
    const focusable = getFocusableElements(dialog)
    if (focusable.length === 0) {
      event.preventDefault()
      dialog.focus()
      return
    }
    const index = document.activeElement instanceof HTMLElement ? focusable.indexOf(document.activeElement) : -1
    const next = event.shiftKey
      ? index <= 0 ? focusable.length - 1 : index - 1
      : index < 0 || index === focusable.length - 1 ? 0 : index + 1
    event.preventDefault()
    focusable[next]?.focus()
  }

  useEffect(() => {
    if (!open) return
    const restore = triggerRef.current
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      close()
    }
    window.addEventListener('keydown', onKeyDown)
    ;(chooseFileRef.current ?? dialogRef.current)?.focus()
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      restore?.focus()
    }
  }, [close, open])

  return <div className={css.root}>
    <button
      ref={triggerRef}
      type="button"
      className={css.trigger}
      disabled={disabled}
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={() => { if (!disabled) setOpen(true) }}
    >
      {labels.button}
    </button>
    {open && <>
      <div className={css.backdrop} aria-hidden="true" onClick={close} />
      <div ref={dialogRef} className={css.surface} role="dialog" aria-modal="true" aria-label={labels.dialog} aria-busy={uploading} tabIndex={-1} onKeyDown={onDialogKeyDown}>
        <div className={css.actions}>
          <button ref={chooseFileRef} type="button" className={css.action} disabled={disabled || uploading} onClick={() => { choose('file') }}>{labels.chooseFile}</button>
          <button type="button" className={css.action} disabled={disabled || uploading} onClick={() => { choose('photos') }}>{labels.choosePhotos}</button>
          <button type="button" className={css.cancel} onClick={close}>{labels.cancel}</button>
        </div>
        {uploading && <div className={css.status} role="status" aria-live="polite">{labels.uploading}</div>}
        <input ref={fileInputRef} data-testid="file-picker-input-file" className={css.visuallyHidden} type="file" multiple disabled={disabled || uploading} tabIndex={-1} onChange={onChange} />
        <input ref={photosInputRef} data-testid="file-picker-input-photos" className={css.visuallyHidden} type="file" accept="image/*" multiple disabled={disabled || uploading} tabIndex={-1} onChange={onChange} />
      </div>
    </>}
  </div>
}
