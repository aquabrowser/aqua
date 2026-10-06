import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Check, Pencil, Plus, Trash2, UserRound } from 'lucide-react'
import { PROFILE_COLOR_VALUES, PROFILE_COLORS, type ProfileColor } from '@shared/profiles'
import type { ProfileSummary } from '@shared/types'
import { Dialog } from '../../components/Dialog'
import { Icon } from '../../components/Icon'
import { cx } from '../../lib/format'
import { FormMessage } from './controls'

function ColorPicker({ value, onChange }: { value: ProfileColor; onChange: (color: ProfileColor) => void }) {
  return (
    <div className="profile-colors" role="radiogroup" aria-label="Colour">
      {PROFILE_COLORS.map((color) => (
        <button
          key={color}
          type="button"
          className={cx('profile-color', value === color && 'selected')}
          role="radio"
          aria-checked={value === color}
          aria-label={color}
          title={color[0].toUpperCase() + color.slice(1)}
          style={{ background: PROFILE_COLOR_VALUES[color] }}
          onClick={() => onChange(color)}
        />
      ))}
    </div>
  )
}

/** Name and colour, for a new profile or an existing one. */
function ProfileForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel
}: {
  initial: { name: string; color: ProfileColor }
  submitLabel: string
  onSubmit: (name: string, color: ProfileColor) => Promise<string | null>
  onCancel?: () => void
}) {
  const [name, setName] = useState(initial.name)
  const [color, setColor] = useState<ProfileColor>(initial.color)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    setBusy(true)
    const problem = await onSubmit(name, color)
    setBusy(false)
    setError(problem)
  }

  return (
    <form className="profile-form" onSubmit={(e) => void submit(e)}>
      <input
        className="text-input"
        value={name}
        placeholder="Profile name, for example Work"
        aria-label="Profile name"
        maxLength={40}
        autoFocus
        onChange={(e) => {
          setName(e.target.value)
          setError(null)
        }}
      />
      <ColorPicker value={color} onChange={setColor} />
      <div className="profile-form-actions">
        {onCancel && (
          <button className="btn ghost" type="button" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button className="btn primary" type="submit" disabled={busy || !name.trim()}>
          {submitLabel}
        </button>
      </div>
      {error && <FormMessage tone="error">{error}</FormMessage>}
    </form>
  )
}

export function ProfilesSection() {
  const [profiles, setProfiles] = useState<ProfileSummary[]>([])
  const [editing, setEditing] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [deleting, setDeleting] = useState<ProfileSummary | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const refresh = useCallback(() => void window.aqua.profiles.list().then(setProfiles), [])
  useEffect(refresh, [refresh])

  const create = async (name: string, color: ProfileColor): Promise<string | null> => {
    const result = await window.aqua.profiles.create({ name, color })
    if (!result.ok) return result.error
    setAdding(false)
    refresh()
    void window.aqua.profiles.open(result.id)
    setNotice(`${name.trim()} opens in a new window. Choose its master password there.`)
    return null
  }

  const save = async (profile: ProfileSummary, name: string, color: ProfileColor): Promise<string | null> => {
    const result = await window.aqua.profiles.update(profile.id, { name, color })
    if (!result.ok) return result.error
    setEditing(null)
    refresh()
    if (profile.current) setNotice('Saved. Windows that are open now show the new name after Aqua restarts.')
    return null
  }

  const remove = async (): Promise<void> => {
    if (!deleting) return
    const result = await window.aqua.profiles.remove(deleting.id)
    if (!result.ok) return setDeleteError(result.error)
    setDeleting(null)
    refresh()
  }

  return (
    <>
      <h2>Profiles</h2>
      <div className="card">
        <p className="card-intro">
          Each profile has its own master password, history, cookies, bookmarks and settings, encrypted in a vault of
          its own, and opens in its own windows. Nothing is shared between them.
        </p>
        {profiles.map((p) =>
          editing === p.id ? (
            <div className="card-row stacked" key={p.id}>
              <ProfileForm
                initial={{ name: p.name, color: p.color }}
                submitLabel="Save"
                onSubmit={(name, color) => save(p, name, color)}
                onCancel={() => setEditing(null)}
              />
            </div>
          ) : (
            <div className="card-row" key={p.id}>
              <span className="profile-dot large" style={{ background: PROFILE_COLOR_VALUES[p.color] }} aria-hidden />
              <div className="text">
                <div className="label">{p.name}</div>
                <div className="hint">{p.current ? 'This window' : p.id === 'default' ? 'Default profile' : ''}</div>
              </div>
              <div className="profile-actions">
                {!p.current && (
                  <button className="btn small" onClick={() => void window.aqua.profiles.open(p.id)}>
                    Open
                  </button>
                )}
                <button
                  className="mini-button"
                  title="Rename"
                  aria-label={`Rename ${p.name}`}
                  onClick={() => setEditing(p.id)}
                >
                  <Icon icon={Pencil} size={14} />
                </button>
                {!p.current && p.id !== 'default' && (
                  <button
                    className="mini-button"
                    title="Delete"
                    aria-label={`Delete ${p.name}`}
                    onClick={() => {
                      setDeleteError(null)
                      setDeleting(p)
                    }}
                  >
                    <Icon icon={Trash2} size={14} />
                  </button>
                )}
              </div>
            </div>
          )
        )}
        <div className="card-row stacked">
          {adding ? (
            <ProfileForm
              initial={{ name: '', color: PROFILE_COLORS[(profiles.length + 1) % PROFILE_COLORS.length] }}
              submitLabel="Add profile"
              onSubmit={create}
              onCancel={() => setAdding(false)}
            />
          ) : (
            <div className="storage-actions">
              <button
                className="btn"
                onClick={() => {
                  setNotice(null)
                  setAdding(true)
                }}
              >
                <Icon icon={Plus} size={14} />
                Add profile
              </button>
              <button className="btn ghost" onClick={() => void window.aqua.profiles.openGuest()}>
                <Icon icon={UserRound} size={14} />
                Open guest window
              </button>
            </div>
          )}
          {notice && <FormMessage tone="success">{notice}</FormMessage>}
        </div>
      </div>
      <p className="muted-note">
        Profile names and colours are stored unencrypted, so a locked window can list them. Everything inside a profile
        is encrypted.
      </p>

      <Dialog
        open={deleting !== null}
        title={`Delete ${deleting?.name ?? ''}?`}
        icon={Trash2}
        tone="danger"
        width={460}
        onCancel={() => setDeleting(null)}
        footer={
          <>
            <button className="btn ghost" onClick={() => setDeleting(null)}>
              Cancel
            </button>
            <button className="btn danger-fill" data-autofocus onClick={() => void remove()}>
              <Icon icon={Check} size={14} />
              Delete profile
            </button>
          </>
        }
      >
        <p>
          This deletes the profile’s vault: its history, cookies, site data, bookmarks and settings. Downloaded files
          stay where they are. There’s no undo.
        </p>
        {deleteError && <FormMessage tone="error">{deleteError}</FormMessage>}
      </Dialog>
    </>
  )
}
