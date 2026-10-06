import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode
} from 'react'
import { ArrowBigUp, ArrowRight, CircleAlert, Eye, EyeOff, UserRound, Users } from 'lucide-react'
import type { VaultStatus } from '@shared/types'
import { AquaMark, Icon } from '../components/Icon'
import { env } from '../store'
import { cx } from '../lib/format'
import { OnboardingSteps, WelcomeIntro } from './Onboarding'

const MIN_LENGTH = 8

/** Horizontal shake for a rejected password (Web Animations: no remount, focus stays put). */
const SHAKE: Keyframe[] = [
  { transform: 'translateX(0)' },
  { transform: 'translateX(-7px)' },
  { transform: 'translateX(6px)' },
  { transform: 'translateX(-4px)' },
  { transform: 'translateX(2px)' },
  { transform: 'translateX(0)' }
]

interface FieldHandle {
  focus(select?: boolean): void
  shake(): void
}

interface PasswordFieldProps {
  value: string
  onChange: (value: string) => void
  placeholder: string
  label: string
  invalid: boolean
  disabled: boolean
  capsLock: boolean
  autoComplete: 'current-password' | 'new-password'
  onKeyEvent: (event: ReactKeyboardEvent) => void
  trailing?: ReactNode
}

const PasswordField = forwardRef<FieldHandle, PasswordFieldProps>(function PasswordField(
  { value, onChange, placeholder, label, invalid, disabled, capsLock, autoComplete, onKeyEvent, trailing },
  ref
) {
  const boxRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [reveal, setReveal] = useState(false)

  useImperativeHandle(ref, () => ({
    focus: (select) => {
      inputRef.current?.focus({ preventScroll: true })
      if (select) inputRef.current?.select()
    },
    shake: () => {
      boxRef.current?.animate(SHAKE, { duration: 380, easing: 'cubic-bezier(0.36, 0.07, 0.19, 0.97)' })
    }
  }))

  return (
    <div ref={boxRef} className={cx('lock-field', invalid && 'invalid', disabled && 'disabled')}>
      <input
        ref={inputRef}
        type={reveal ? 'text' : 'password'}
        value={value}
        placeholder={placeholder}
        aria-label={label}
        aria-invalid={invalid}
        autoComplete={autoComplete}
        spellCheck={false}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyEvent}
        onKeyUp={onKeyEvent}
      />
      <span className={cx('caps-badge', capsLock && 'visible')} aria-live="polite">
        {capsLock && (
          <>
            <Icon icon={ArrowBigUp} size={12} stroke={1.8} />
            Caps Lock
          </>
        )}
      </span>
      <button
        type="button"
        className="lock-field-button"
        tabIndex={-1}
        aria-label={reveal ? 'Hide password' : 'Show password'}
        title={reveal ? 'Hide password' : 'Show password'}
        disabled={disabled || !value}
        onPointerDown={(e) => e.preventDefault()}
        onClick={() => setReveal((r) => !r)}
      >
        <Icon icon={reveal ? EyeOff : Eye} size={15} />
      </button>
      {trailing}
    </div>
  )
})

/** 0 = too short … 4 = strong. A guide, not a gate: the vault only enforces the minimum length. */
function strength(password: string): 0 | 1 | 2 | 3 | 4 {
  const length = [...password].length
  if (length < MIN_LENGTH) return 0
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(password)).length
  const repetitive = /^(.)\1+$/.test(password) || /^(?:password|qwerty|letmein|12345678|abc12345)/i.test(password)
  if (repetitive) return 1
  let score = 1
  if (length >= 12) score++
  if (classes >= 3 || (classes >= 2 && length >= 14)) score++
  if (length >= 16 || (classes === 4 && length >= 12)) score++
  return Math.min(4, score) as 1 | 2 | 3 | 4
}

const STRENGTH_LABELS = ['', 'Weak', 'Fair', 'Good', 'Strong'] as const

function StrengthMeter({ password }: { password: string }) {
  const level = strength(password)
  const hint =
    password.length === 0
      ? `Use at least ${MIN_LENGTH} characters`
      : level === 0
        ? `${MIN_LENGTH - [...password].length} more character${MIN_LENGTH - [...password].length === 1 ? '' : 's'} needed`
        : STRENGTH_LABELS[level]
  return (
    <div className={cx('strength', `level-${level}`)} aria-live="polite">
      <div className="strength-bars" aria-hidden>
        {[1, 2, 3, 4].map((n) => (
          <span key={n} className={cx(level >= n && 'on')} />
        ))}
      </div>
      <span className="strength-label">{hint}</span>
    </div>
  )
}

function Spinner() {
  return <span className="lock-spinner" aria-hidden />
}

/**
 * Full-window vault screen: first-run setup (the welcome's first two steps, see Onboarding),
 * unlock, and the one-time upgrade of a pre-Argon2id vault. Covers the whole window, including
 * the tab strip.
 */
export function LockScreen({ status, leaving }: { status: VaultStatus; leaving: boolean }) {
  const mode: 'setup' | 'unlock' | 'upgrade' =
    status.state === 'setup' ? 'setup' : status.legacyUpgrade ? 'upgrade' : 'unlock'
  const setup = mode === 'setup'
  // A profile added to an Aqua already in use skips the welcome: it only needs its own password.
  const addedProfile = env.profile.kind === 'profile'
  const [step, setStep] = useState<'welcome' | 'password'>(addedProfile ? 'password' : 'welcome')
  const intro = setup && step === 'welcome'

  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [invalid, setInvalid] = useState<'password' | 'confirm' | null>(null)
  const [busy, setBusy] = useState(false)
  const [capsLock, setCapsLock] = useState(false)
  const [waitUntil, setWaitUntil] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  const passwordRef = useRef<FieldHandle>(null)
  const confirmRef = useRef<FieldHandle>(null)

  // Autofocus on mount and whenever the mode changes (the welcome step focuses its own button).
  useEffect(() => {
    if (leaving || intro) return
    const frame = requestAnimationFrame(() => passwordRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [mode, leaving, intro])

  // Caps Lock is only knowable from input events; track it anywhere on the screen.
  useEffect(() => {
    const track = (event: KeyboardEvent | MouseEvent): void => {
      if (typeof event.getModifierState === 'function') setCapsLock(event.getModifierState('CapsLock'))
    }
    window.addEventListener('keydown', track, true)
    window.addEventListener('keyup', track, true)
    window.addEventListener('mousedown', track, true)
    return () => {
      window.removeEventListener('keydown', track, true)
      window.removeEventListener('keyup', track, true)
      window.removeEventListener('mousedown', track, true)
    }
  }, [])

  // Count down a rate-limit back-off.
  useEffect(() => {
    if (!waitUntil) return
    const timer = window.setInterval(() => {
      const t = Date.now()
      setNow(t)
      if (t >= waitUntil) {
        setWaitUntil(0)
        setError(null)
        setInvalid(null)
        requestAnimationFrame(() => passwordRef.current?.focus())
      }
    }, 250)
    return () => window.clearInterval(timer)
  }, [waitUntil])

  const secondsLeft = waitUntil ? Math.max(0, Math.ceil((waitUntil - now) / 1000)) : 0
  const locked = busy || secondsLeft > 0

  const reject = (field: 'password' | 'confirm', message: string): void => {
    setError(message)
    setInvalid(field)
    const target = field === 'confirm' ? confirmRef.current : passwordRef.current
    target?.shake()
    requestAnimationFrame(() => target?.focus(true))
  }

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (locked) return
    if (setup) {
      if ([...password].length < MIN_LENGTH) return reject('password', `Use at least ${MIN_LENGTH} characters.`)
      if (password !== confirm) return reject('confirm', 'The passwords don’t match.')
    } else if (!password) return

    setBusy(true)
    setError(null)
    setInvalid(null)
    const result = setup ? await window.aqua.vault.setup(password) : await window.aqua.vault.unlock(password)
    setBusy(false)
    if (result.success) {
      setPassword('')
      setConfirm('')
      return
    }
    if (!setup) setPassword('')
    if (result.retryAfter) {
      setNow(Date.now())
      setWaitUntil(Date.now() + result.retryAfter * 1000)
    }
    reject('password', result.error ?? 'Wrong password.')
  }

  const onKeyEvent = (event: ReactKeyboardEvent): void => setCapsLock(event.getModifierState('CapsLock'))

  // With several profiles, the lock screen says which one this is.
  const named = env.profile.profileCount > 1 ? env.profile.name : 'Aqua'
  const title = setup
    ? addedProfile
      ? `Set up ${env.profile.name}`
      : 'Create your vault'
    : mode === 'upgrade'
      ? 'Upgrade your vault'
      : `${named} is locked`
  // Unlocking needs no explanation; first run and the one-time upgrade do.
  const subtitle = setup
    ? addedProfile
      ? `Choose a master password for ${env.profile.name}. It’s separate from your other profiles’ passwords and can’t be recovered if you forget it.`
      : 'Choose a master password to encrypt your profile on this device. It can’t be recovered if you forget it.'
    : mode === 'upgrade'
      ? 'Aqua now encrypts your whole profile. Enter your current master password to upgrade it.'
      : null

  const message = secondsLeft > 0 ? `Too many attempts. Try again in ${secondsLeft}s.` : error
  const progress = busy ? (setup ? 'Creating your vault…' : 'Unlocking…') : null

  return (
    <div className={cx('lock-screen', leaving && 'leaving')} role="dialog" aria-modal="true" aria-label={title}>
      <div className="lock-titlebar" />
      <div className="lock-center">
        <div className="lock-panel">
          {/* The logo slot of the window: the first thing shown at every launch. */}
          <div className={cx('lock-mark', busy && 'working')}>
            <AquaMark size={56} />
          </div>
          {intro ? (
            <WelcomeIntro onContinue={() => setStep('password')} />
          ) : (
            <>
              <h1 className={cx('lock-title', !subtitle && 'solo')}>{title}</h1>
              {subtitle && <p className="lock-subtitle">{subtitle}</p>}

              <form className="lock-form" onSubmit={(e) => void submit(e)} noValidate>
                <PasswordField
                  ref={passwordRef}
                  value={password}
                  onChange={(v) => {
                    setPassword(v)
                    if (!waitUntil) {
                      setError(null)
                      setInvalid(null)
                    }
                  }}
                  placeholder={setup ? 'New master password' : 'Master password'}
                  label={setup ? 'New master password' : 'Master password'}
                  invalid={invalid === 'password'}
                  disabled={locked}
                  capsLock={capsLock}
                  autoComplete={setup ? 'new-password' : 'current-password'}
                  onKeyEvent={onKeyEvent}
                  trailing={
                    !setup && (
                      <button
                        className="lock-submit-icon"
                        type="submit"
                        aria-label="Unlock"
                        title="Unlock"
                        disabled={!password || locked}
                      >
                        {busy ? <Spinner /> : <Icon icon={ArrowRight} size={16} stroke={1.8} />}
                      </button>
                    )
                  }
                />

                {setup && (
                  <>
                    <StrengthMeter password={password} />
                    <PasswordField
                      ref={confirmRef}
                      value={confirm}
                      onChange={(v) => {
                        setConfirm(v)
                        if (invalid === 'confirm') {
                          setError(null)
                          setInvalid(null)
                        }
                      }}
                      placeholder="Confirm master password"
                      label="Confirm master password"
                      invalid={invalid === 'confirm'}
                      disabled={locked}
                      capsLock={capsLock}
                      autoComplete="new-password"
                      onKeyEvent={onKeyEvent}
                    />
                    <button
                      className="btn primary lock-submit"
                      type="submit"
                      disabled={locked || !password || !confirm}
                    >
                      {busy && <Spinner />}
                      {busy ? 'Creating vault…' : 'Create vault'}
                    </button>
                  </>
                )}

                {/* Fixed-height slot: the panel never shifts when a message appears. */}
                <div className="lock-status" role="alert" aria-live="assertive">
                  {message ? (
                    <span className="lock-alert" key={message}>
                      <Icon icon={CircleAlert} size={14} stroke={1.8} />
                      {message}
                    </span>
                  ) : (
                    progress && <span className="lock-progress">{progress}</span>
                  )}
                </div>
              </form>
              {!setup && mode !== 'upgrade' && <OtherProfiles />}
              {setup && !addedProfile && (
                <div className="onboarding-footer">
                  <button className="lock-back" type="button" disabled={busy} onClick={() => setStep('welcome')}>
                    Back
                  </button>
                  <OnboardingSteps current={2} />
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * Someone without this profile's password can still browse: as a guest (nothing is kept), or in
 * another profile, with that profile's own password.
 */
function OtherProfiles() {
  const several = env.profile.profileCount > 1
  return (
    <div className="lock-profiles">
      <button
        className="lock-switch"
        type="button"
        onClick={() =>
          several ? void window.aqua.ui.contextMenu({ kind: 'profiles' }) : void window.aqua.profiles.openGuest()
        }
      >
        <Icon icon={several ? Users : UserRound} size={14} stroke={1.7} />
        {several ? 'Other profiles' : 'Browse as guest'}
      </button>
    </div>
  )
}
