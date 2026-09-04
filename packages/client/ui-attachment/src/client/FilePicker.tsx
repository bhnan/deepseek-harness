import { useRef } from 'react'

export interface FilePickerProps {
  disabled?: boolean
  onFiles: (files: readonly File[]) => void | Promise<void>
  label?: string
}

/** Native, mobile-friendly picker triggered directly from the user gesture. */
export function FilePicker({ disabled = false, onFiles, label = '选择文件' }: FilePickerProps) {
  const input = useRef<HTMLInputElement>(null)
  return <>
    <button type="button" disabled={disabled} onClick={() => input.current?.click()}>{label}</button>
    <input ref={input} type="file" multiple hidden onChange={(event) => {
      const files = [...(event.currentTarget.files ?? [])]
      event.currentTarget.value = ''
      if (files.length > 0) void onFiles(files)
    }} />
  </>
}
