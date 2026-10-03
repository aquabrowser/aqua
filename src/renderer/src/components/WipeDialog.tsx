import { useEffect, useState, type FormEvent } from 'react'
import { CircleAlert, Trash2 } from 'lucide-react'
import { Dialog } from './Dialog'
import { Icon } from './Icon'

const CONFIRMATION = 'WIPE'

/**
 * "Wipe Vault / Reset All Data": erases the encrypted profile and every piece
 * of browsing data, then restarts Aqua into first-run setup. Requires typing
 * the confirmation word; nothing happens on a single stray click or keypress.
 */
export function WipeDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setText('')
    setError(null)
    setBusy(false)
  }, [open])

  const confirmed = text === CONFIRMATION

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!confirmed || busy) return
    setBusy(true)
    // On success Aqua exits and relaunches; the promise only settles on failure.
    const result = await window.aqua.vault.wipe(text)
    if (!result.success) {
      setBusy(false)
      setError(result.error ?? 'The profile could not be wiped.')
    }
  }

  return (
    <Dialog
      open={open}
      title="Wipe vault and reset Aqua?"
      icon={Trash2}
      tone="danger"
      width={460}
      busy={busy}
      onCancel={onClose}
      footer={
        <>
          <button className="btn ghost" type="button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button className="btn danger-fill" type="submit" form="wipe-form" disabled={!confirmed || busy}>
            {busy ? 'Wiping…' : 'Wipe and restart'}
          </button>
        </>
      }
    >
      <p>This deletes everything Aqua keeps on this device:</p>
      <ul className="dialog-list">
        <li>Bookmarks, history, open tabs, settings and site permissions</li>
        <li>Cookies and site data (you’ll be signed out everywhere)</li>
        <li>The download list and blocking settings (downloaded files stay put)</li>
      </ul>
      <p className="dialog-note">
        There’s no undo and no way to get it back. Aqua restarts and asks you for a new master password.
      </p>
      <form id="wipe-form" className="dialog-field" onSubmit={(e) => void submit(e)}>
        <label htmlFor="wipe-confirm">
          Type <kbd>{CONFIRMATION}</kbd> to confirm
        </label>
        <input
          id="wipe-confirm"
          className="text-input mono"
          value={text}
          autoComplete="off"
          spellCheck={false}
          disabled={busy}
          data-autofocus
          aria-invalid={text.length > 0 && !CONFIRMATION.startsWith(text)}
          onChange={(e) => {
            setText(e.target.value.trim())
            setError(null)
          }}
        />
        {error && (
          <div className="form-message error" role="alert">
            <Icon icon={CircleAlert} size={14} />
            {error}
          </div>
        )}
      </form>
    </Dialog>
  )
}
