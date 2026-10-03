/**
 * Runtime guards for IPC arguments. The UI renderer is trusted code, but every
 * payload is still validated: a compromised renderer must not be able to push
 * arbitrary types into privileged code paths.
 */
export class ValidationError extends Error {}

export function str(value: unknown, maxLength = 8192): string {
  if (typeof value !== 'string') throw new ValidationError('expected string')
  if (value.length > maxLength) throw new ValidationError('string too long')
  return value
}

export function optStr(value: unknown, maxLength = 8192): string | undefined {
  return value === undefined ? undefined : str(value, maxLength)
}

export function bool(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new ValidationError('expected boolean')
  return value
}

export function int(value: unknown, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new ValidationError('expected integer')
  if (value < min || value > max) throw new ValidationError('integer out of range')
  return value
}

export function num(value: unknown, min = -Infinity, max = Infinity): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new ValidationError('expected number')
  if (value < min || value > max) throw new ValidationError('number out of range')
  return value
}

export function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new ValidationError(`expected one of ${allowed.join(', ')}`)
  }
  return value as T
}

export function obj(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError('expected object')
  }
  return value as Record<string, unknown>
}

export function arr<T>(value: unknown, item: (v: unknown) => T, maxLength = 1000): T[] {
  if (!Array.isArray(value)) throw new ValidationError('expected array')
  if (value.length > maxLength) throw new ValidationError('array too long')
  return value.map(item)
}
