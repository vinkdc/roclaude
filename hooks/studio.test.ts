import { expect, test } from 'claude-code/testing'

import { auditRemotes } from './lint'
import {
  countErrors,
  dangersIn,
  luauLookup,
  stripLineNumbers,
  studioName,
  studioTool,
  writesScripts,
} from './studio'

const EDIT = 'mcp__Roblox_Studio__multi_edit'
const LUAU = 'mcp__Roblox_Studio__execute_luau'
const SID = 'studio-1'
const PATH = 'game.ServerScriptService.Shop'

test('recognizes Roblox Studio MCP tools and nothing else', () => {
  expect(studioTool(EDIT)).toEqual({ server: 'Roblox_Studio', name: 'multi_edit' })
  expect(studioTool('mcp__claude_ai_Gmail__create_draft')).toBeNull()
  expect(studioTool('Bash')).toBeNull()
})

test('strips script_read line numbers back to the source', () => {
  expect(stripLineNumbers('     1→local a = 1\n     2→\n    10→return a')).toBe('local a = 1\n\nreturn a')
})

test('builds a FindFirstChild chain for a dot path', () => {
  expect(luauLookup('game.ServerScriptService.Shop')).toBe(
    'game:FindFirstChild("ServerScriptService"):FindFirstChild("Shop")',
  )
})

test('flags destructive and data-changing Luau, not reads', () => {
  expect(dangersIn('workspace.Map:ClearAllChildren()').map(d => d.id)).toEqual(['destroy'])
  expect(dangersIn('store:SetAsync("k", 1)').map(d => d.id)).toEqual(['datastore-write'])
  expect(dangersIn('require(123456789)').map(d => d.id)).toEqual(['remote-code'])
  expect(writesScripts('script.Source = ""')).toBe(true)
  expect(writesScripts('local s = Instance.new("Script")')).toBe(true)
  expect(writesScripts('ScriptEditorService:UpdateSourceAsync(s, f)')).toBe(true)
  expect(writesScripts('return s.Source == t.Source')).toBe(false)
  expect(writesScripts('local p = Instance.new("Part")')).toBe(false)
  expect(dangersIn('return #workspace:GetChildren()')).toEqual([])
  expect(dangersIn('if a.Source == b then end')).toEqual([])
})

test('counts error lines in Studio output', () => {
  const output = [
    'vinkdc joined live editing session.',
    'ServerScriptService.Shop:12: attempt to index nil with \'Coins\'',
    'Stack Begin',
    'Unable to load plugin icon.',
  ].join('\n')
  expect(countErrors(output)).toBe(1)
})

test('reads the studio name', () => {
  expect(studioName('{"studios":[{"id":"x","name":"test2 (placeId: 901)"}]}')).toBe('test2')
  expect(studioName('{"studios":[]}')).toBeNull()
})

test('the remote audit flags unchecked client values and passes checked ones', () => {
  const unchecked = 'Remote.OnServerEvent:Connect(function(player, amount: number)\n  coins += amount\nend)'
  const checked =
    'Remote.OnServerEvent:Connect(function(player, amount)\n  if typeof(amount) ~= "number" then return end\nend)'
  expect(auditRemotes(unchecked).map(i => i.rule)).toEqual(['remote-unchecked'])
  expect(auditRemotes(checked)).toEqual([])
  expect(auditRemotes('Remote.OnServerEvent:Connect(function(player)\nend)')).toEqual([])
})

test('the remote audit trusts handlers that first limit who may call them', () => {
  const admin =
    'Admin.OnServerEvent:Connect(function(player, message)\n  if not isAdmin(player) then\n    player:Kick("Exploiting")\n    return\n  end\n  announce(message)\nend)'
  const owner =
    'Music.OnServerEvent:Connect(function(player, action, ...)\n  if player.UserId ~= ADMIN_USER_ID then\n    return\n  end\n  play(...)\nend)'
  expect(auditRemotes(admin)).toEqual([])
  expect(auditRemotes(owner)).toEqual([])
})

test('a multi_edit is saved first, reviewed, and undone through script_read and multi_edit', async ($, on) => {
  let source = 'local Shop = {}\nreturn Shop'
  const calls: string[] = []

  on('mcp.call', ($, e) => {
    calls.push(e.tool)
    if (e.tool === 'script_read') {
      const numbered = source.split('\n').map((line, i) => `     ${i + 1}→${line}`).join('\n')
      return { value: { content: [{ type: 'text' as const, text: numbered }], isError: false } }
    }
    if (e.tool === 'multi_edit') {
      const edit = (e.args.edits as { old_string: string; new_string: string }[])[0]!
      source = source.replace(edit.old_string, edit.new_string)
      return { value: { content: [{ type: 'text' as const, text: 'ok' }], isError: false } }
    }
    return { value: { content: [], isError: true } }
  })
  on('tool.call', ($, e) => {
    const edit = ((e as unknown as { edits: { old_string: string; new_string: string }[] }).edits)[0]!
    source = source.replace(edit.old_string, edit.new_string)
    return { result: 'ok' as never }
  })

  const ran = await $.tool.call({
    tool: EDIT,
    studio_id: SID,
    datamodel_type: 'Edit',
    file_path: PATH,
    edits: [{ old_string: 'return Shop', new_string: 'Remote.OnServerEvent:Connect(function(player, item)\n  give(player, item)\nend)\nwait(1)\nreturn Shop' }],
  } as never)

  const context = (ran.context ?? []).join('\n')
  expect(context).toContain('remote-unchecked')
  expect(context).toContain('task-wait')
  expect(context).toContain('playtest')
  expect(source).toContain('OnServerEvent')

  const undone = await $.command.run({ command: 'roclaude', args: 'undo' } as never)
  expect(undone.text).toContain('Restored')
  expect(source).toBe('local Shop = {}\nreturn Shop')
  expect(calls).toEqual(['script_read', 'script_read', 'script_read', 'multi_edit'])
})

test('execute_luau that deletes things is put to the person', async ($, on) => {
  on('tool.check', () => ({ decision: 'allow' }))

  const risky = await $.tool.check({ tool: LUAU, input: { code: 'workspace.Map:Destroy()' } })
  const safe = await $.tool.check({ tool: LUAU, input: { code: 'return workspace.Map.Name' } })

  expect(risky.decision).toBe('ask')
  expect(risky.reason).toContain('deletes instances')
  expect(safe.decision).toBe('allow')
})

test('execute_luau that writes script source is refused toward multi_edit, even when allowed', async ($, on) => {
  on('tool.check', () => ({ decision: 'allow' }))

  const create = await $.tool.check({
    tool: LUAU,
    input: { code: 'local s = Instance.new("Script")\ns.Source = [[print(1)]]\ns.Parent = game.ServerScriptService' },
  })

  expect(create.decision).toBe('deny')
  expect(create.reason).toContain('multi_edit')
})
