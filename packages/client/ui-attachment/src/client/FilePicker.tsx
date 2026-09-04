import { useRef } from 'react'
import css from './FilePicker.module.css'

export interface FilePickerProps {
  disabled?: boolean
  onFiles: (files: readonly File[]) => void | Promise<void>
  label?: string
}

/** Native, mobile-friendly picker triggered directly from the user gesture. */
export function FilePicker({ disabled = false, onFiles, label = '上传文件' }: FilePickerProps) {
  const input = useRef<HTMLInputElement>(null)
  return <>
    <button
      type="button"
      className={css.trigger}
      disabled={disabled}
      aria-label={label}
      title={label}
      onClick={() => input.current?.click()}
    >
      <svg aria-hidden="true" className={css.icon} viewBox="0 0 20 20" fill="none">
        <path d="M10 3v9m0-9L6.8 6.2M10 3l3.2 3.2M4 11.5v3A1.5 1.5 0 0 0 5.5 16h9a1.5 1.5 0 0 0 1.5-1.5v-3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
    <input ref={input} type="file" multiple hidden onChange={(event) => {
      const files = [...(event.currentTarget.files ?? [])]
      event.currentTarget.value = ''
      if (files.length > 0) void onFiles(files)
    }} />
  </>
}
