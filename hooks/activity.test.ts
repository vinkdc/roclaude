import { expect, test } from 'claude-code/testing'

import { normalizePath, pathsChanged, settle, summarize, touch } from './activity'

test('normalizes paths to one form', () => {
  expect(normalizePath('game.ServerScriptService.Shop')).toBe('ServerScriptService.Shop')
  expect(normalizePath('workspace.Part')).toBe('Workspace.Part')
  expect(normalizePath('game.Workspace.Part')).toBe('Workspace.Part')
})

test('finds the objects Luau changes, not the ones it only reads', () => {
  expect(pathsChanged('workspace.Part.Anchored = true\nworkspace.Part.Position = Vector3.new(0, 5, 0)')).toEqual([
    'Workspace.Part',
  ])
  expect(pathsChanged('game.Workspace.Old:Destroy()')).toEqual(['Workspace.Old'])
  expect(pathsChanged('return workspace.Part.Position')).toEqual([])
  expect(pathsChanged('if workspace.Part.Anchored == true then end')).toEqual([])
  expect(pathsChanged('workspace.Gravity = 50')).toEqual([])
})

test('keeps the strongest action and the first position', () => {
  const step = (list: ReturnType<typeof touch>, path: string, action: 'read' | 'edited' | 'created' | 'changed') =>
    touch(list, { path, kind: 'script', action, isActive: false, activeAs: null })
  let list = step([], 'game.ServerScriptService.Shop', 'read')
  list = step(list, 'ServerScriptService.Admin', 'read')
  list = step(list, 'ServerScriptService.Shop', 'edited')
  list = step(list, 'ServerScriptService.Shop', 'read')
  expect(list.map(one => [one.path, one.action])).toEqual([
    ['ServerScriptService.Shop', 'edited'],
    ['ServerScriptService.Admin', 'read'],
  ])
})

test('settles a row without changing what was done to it', () => {
  const list = touch([], { path: 'Workspace.Part', kind: 'instance', action: 'read', isActive: true, activeAs: 'changing' })
  expect(settle(list, 'workspace.Part')[0]).toMatchObject({ action: 'read', isActive: false, activeAs: null })
})

test('sums up what Claude did', () => {
  let list = touch([], { path: 'ServerScriptService.Shop', kind: 'script', action: 'edited', isActive: false, activeAs: null })
  list = touch(list, { path: 'ServerScriptService.OwnerTag', kind: 'script', action: 'created', isActive: false, activeAs: null })
  list = touch(list, { path: 'Workspace.Part', kind: 'instance', action: 'changed', isActive: false, activeAs: null })
  list = touch(list, { path: 'ServerScriptService.Admin', kind: 'script', action: 'read', isActive: false, activeAs: null })
  expect(summarize(list)).toEqual({
    title: 'Claude edited 2 scripts, changed 1 object',
    detail: 'OwnerTag, Shop, Part · read 1',
  })
  expect(summarize([]).title).toBe('Nothing touched yet')
})
