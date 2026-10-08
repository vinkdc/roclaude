// What Claude touched in the open place, for the Studio activity pane.
import type { PropMap, TouchAction, TouchedItem } from '../types'

// Stronger actions win when Claude touches the same thing twice.
const STRENGTH: Record<TouchAction, number> = { read: 0, changed: 1, edited: 2, created: 3 }

/** A dot path as one display form: no `game.`, `workspace` as `Workspace`. */
export function normalizePath(path: string): string {
  return path
    .trim()
    .replace(/^game\./, '')
    .replace(/^workspace(?=\.|$)/, 'Workspace')
}

/** The service a path lies in: its first segment. */
export const serviceOf = (path: string) => normalizePath(path).split('.')[0] ?? path

/** The last segment of a path, what a row shows. */
export const leafOf = (path: string) => normalizePath(path).split('.').pop() ?? path

/**
 * Adds or updates one touched item: a new path goes to the end, a known one
 * keeps its place and its strongest action. `isActive` marks a call in flight.
 */
export function touch(
  list: readonly TouchedItem[],
  item: Omit<TouchedItem, 'seq' | 'path'> & { path: string },
): TouchedItem[] {
  const path = normalizePath(item.path)
  const at = list.findIndex(one => one.path === path)
  if (at === -1) {
    const seq = (list[list.length - 1]?.seq ?? 0) + 1
    return [...list, { ...item, path, seq }]
  }
  const old = list[at]!
  const action = STRENGTH[item.action] >= STRENGTH[old.action] ? item.action : old.action
  const next = [...list]
  next[at] = {
    ...old,
    action,
    kind: item.kind,
    isActive: item.isActive,
    activeAs: item.activeAs,
    // The first state Claude saw, and the latest it left.
    propsBefore: old.propsBefore !== undefined ? old.propsBefore : item.propsBefore,
    propsAfter: item.propsAfter !== undefined ? item.propsAfter : old.propsAfter,
  }
  return next
}

/** An object's properties from inspect_instance's JSON answer. */
export function parseProps(text: string): PropMap | undefined {
  try {
    const info = JSON.parse(text) as { properties?: Record<string, unknown> }
    if (info.properties === undefined) return undefined
    const props: Record<string, string | number | boolean> = {}
    for (const [name, value] of Object.entries(info.properties)) {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') props[name] = value
    }
    return props
  } catch {
    return undefined
  }
}

// Properties that change by themselves or say nothing to a person.
const NOISE = new Set(['UniqueId', 'AssemblyLinearVelocity', 'AssemblyAngularVelocity', 'Capabilities', 'Sandboxed'])

/** The properties that differ between two states of an object, by name. */
export function propChanges(before: PropMap, after: PropMap): { name: string; before: string; after: string }[] {
  const names = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(name => !NOISE.has(name)).sort()
  return names
    .filter(name => before[name] !== after[name])
    .map(name => ({ name, before: showValue(name, before[name]), after: showValue(name, after[name]) }))
}

/** A property value as a person reads it: colours as RGB, enums by name, rounded numbers. */
export function showValue(name: string, value: string | number | boolean | undefined): string {
  if (value === undefined) return '(none)'
  if (typeof value === 'number') return String(Math.round(value * 1000) / 1000)
  if (typeof value === 'boolean') return String(value)
  if (/Color/.test(name) && /^-?[\d.]+, -?[\d.]+, -?[\d.]+$/.test(value)) {
    const rgb = value.split(',').map(part => Math.round(Number(part) * 255))
    return `rgb(${rgb.join(', ')})`
  }
  if (value.startsWith('Enum.')) return value.split('.').pop() ?? value
  const numbers = value.split(',').map(part => part.trim())
  if (numbers.length > 1 && numbers.every(part => /^-?[\d.e-]+$/.test(part))) {
    return numbers.map(part => String(Math.round(Number(part) * 100) / 100)).join(', ')
  }
  return value.length > 40 ? `${value.slice(0, 39)}…` : value
}

/** Marks every item settled, at the end of a call. */
export const settle = (list: readonly TouchedItem[], path: string) =>
  list.map(one => (one.path === normalizePath(path) ? { ...one, isActive: false, activeAs: null } : one))

const ROOT = String.raw`(?:game|workspace)(?:\.[A-Za-z_]\w*)+`
const MUTATING = 'Destroy|ClearAllChildren|SetAttribute|PivotTo|MoveTo|AddTag|RemoveTag|Remove|ScaleTo|SetPrimaryPartCFrame'
const ASSIGN = new RegExp(`\\b(${ROOT})\\s*=(?!=)`, 'g')
const CALL = new RegExp(`\\b(${ROOT})\\s*:\\s*(?:${MUTATING})\\s*\\(`, 'g')

/**
 * The instances Luau changes, as far as its text shows: `workspace.Part.Color = x`
 * changes Workspace.Part, `workspace.Old:Destroy()` changes Workspace.Old.
 * Changes made through a local variable are not seen.
 */
export function pathsChanged(code: string): string[] {
  const found: string[] = []
  const add = (path: string) => {
    const normal = normalizePath(path)
    if (normal.includes('.') && !found.includes(normal)) found.push(normal)
  }
  for (const match of code.matchAll(ASSIGN)) {
    const segments = (match[1] ?? '').split('.')
    add(segments.slice(0, -1).join('.'))
  }
  for (const match of code.matchAll(CALL)) add(match[1] ?? '')
  return found
}

/** One line saying what Claude did, for the pane's card. */
export function summarize(list: readonly TouchedItem[]): { title: string; detail: string } {
  const scripts = (action: TouchAction) => list.filter(one => one.kind === 'script' && one.action === action)
  const edited = [...scripts('created'), ...scripts('edited')]
  const changed = list.filter(one => one.kind === 'instance' && (one.action === 'changed' || one.action === 'created'))
  const read = list.filter(one => one.action === 'read')

  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
  const parts: string[] = []
  if (edited.length > 0) parts.push(`edited ${plural(edited.length, 'script')}`)
  if (changed.length > 0) parts.push(`changed ${plural(changed.length, 'object')}`)
  const title =
    parts.length > 0
      ? `Claude ${parts.join(', ')}`
      : read.length > 0
        ? `Claude read ${plural(read.length, 'item')}`
        : 'Nothing touched yet'

  const names = [...edited, ...changed].map(one => leafOf(one.path))
  const shown = names.slice(0, 3).join(', ') + (names.length > 3 ? ` +${names.length - 3}` : '')
  const detail = [shown, read.length > 0 && parts.length > 0 ? `read ${read.length}` : '']
    .filter(text => text !== '')
    .join(' · ')
  return { title, detail }
}
