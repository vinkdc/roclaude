import { expect, test } from 'claude-code/testing'

import { lintLuau } from './lint'

const rules = (path: string, source: string) => lintLuau(path, source).map(issue => issue.rule)

test('flags the deprecated global scheduler functions', () => {
  expect(rules('a.luau', 'wait(1)\nspawn(f)\ndelay(2, f)')).toEqual([
    'task-wait',
    'task-spawn',
    'task-delay',
  ])
})

test('leaves task.*, :Wait and local definitions alone', () => {
  expect(rules('a.luau', 'task.wait(1)\nsignal:Wait()\nlocal function wait() end')).toEqual([])
})

test('ignores comments and strings', () => {
  expect(rules('a.luau', '-- wait(1)\nprint("wait(1)")\n--[[\nspawn(f)\n]]\nlocal x = 1')).toEqual([])
})

test('flags game.Service, lowercase methods and the Instance.new parent', () => {
  const found = rules(
    'a.luau',
    'local P = game.Players\npart.Touched:connect(f)\nlocal p = Instance.new("Part", workspace)',
  )
  expect(found).toEqual(['get-service', 'lowercase-method', 'instance-parent-arg'])
})

test('flags LocalPlayer only in server scripts', () => {
  const source = 'local me = Players.LocalPlayer'
  expect(rules('src/server/Main.server.luau', source)).toEqual(['server-localplayer'])
  expect(rules('src/client/Main.client.luau', source)).toEqual([])
})

test('numbers lines from the snippet start', () => {
  expect(lintLuau('a.luau', 'local a = 1\nwait()', 40)[0]?.line).toBe(41)
})
