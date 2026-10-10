import { expect, mock, test } from 'claude-code/testing'

import { scanRemotes } from './lint'
import { changesPlace, grepScripts, isVendor, stillAsSeen, studioMode, teamFrom } from './studio'

const EDIT = 'mcp__Roblox_Studio__multi_edit'
const READ = 'mcp__Roblox_Studio__script_read'
const PATH = 'game.ServerScriptService.Shop'

test('follows who joins and leaves the Team Create session', () => {
  const output = [
    'vinkdc joined live editing session.',
    'Unable to load plugin icon.',
    'alex_dev joined live editing session.',
    'vinkdc left live editing session.',
  ].join('\n')
  expect(teamFrom(output, [])).toEqual(['alex_dev'])
  expect(teamFrom('sam joined live editing session.', ['alex_dev'])).toEqual(['alex_dev', 'sam'])
})

test('compares a script with what Claude read, whole or by range', () => {
  const source = 'a\nb\nc\nd'
  expect(stillAsSeen({ start: 1, lines: ['a', 'b', 'c', 'd'], isWhole: true }, source)).toBe(true)
  expect(stillAsSeen({ start: 1, lines: ['a', 'b', 'c'], isWhole: true }, source)).toBe(false)
  expect(stillAsSeen({ start: 2, lines: ['b', 'c'], isWhole: false }, source)).toBe(true)
  expect(stillAsSeen({ start: 2, lines: ['b', 'X'], isWhole: false }, source)).toBe(false)
})

test('reads script_grep matches into scripts', () => {
  const text = [
    'Path: ServerScriptService.Admin | Line: 12 | a.OnServerEvent:Connect(function(player)',
    'Path: ServerScriptService.Admin | Line: 40 | b.OnServerEvent:Connect(function(player, x)',
    'Path: ReplicatedStorage.Hitbox | Line: 7 | c.OnServerEvent:Connect(function(player)',
  ].join('\n')
  expect(grepScripts(text)).toEqual({ scripts: ['ServerScriptService.Admin', 'ReplicatedStorage.Hitbox'], matches: 3 })
})

test('classifies every handler', () => {
  const source = [
    'Buy.OnServerEvent:Connect(function(player, item)',
    '  give(player, item)',
    'end)',
    'Admin.OnServerEvent:Connect(function(player, msg)',
    '  if not isAdmin(player) then return end',
    'end)',
    'Ping.OnServerEvent:Connect(function(player)',
    'end)',
    'Get.OnServerInvoke = function(player, id)',
    '  if typeof(id) ~= "number" then return end',
    'end',
  ].join('\n')
  expect(scanRemotes(source).map(h => [h.remote, h.kind, h.status])).toEqual([
    ['Buy', 'event', 'unchecked'],
    ['Admin', 'event', 'gated'],
    ['Ping', 'event', 'no-args'],
    ['Get', 'function', 'checked'],
  ])
})

// What the fake Studio's Output holds, for get_console_output.
let consoleOutput = ''
// The fake place's objects and their properties, for inspect_instance.
const objects = new Map<string, Record<string, string | number | boolean>>()
// The mod's script_read calls so far, and which one fails (none: -1).
let scriptReads = 0
let failingRead = -1

// A fake Studio: scripts by path, answering the Studio tools the mod and Claude call.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeStudio(on: any, scripts: Map<string, string>) {
  const numbered = (source: string) => source.split('\n').map((line, i) => `     ${i + 1}→${line}`).join('\n')
  const text = (t: string, isError = false) => ({ value: { content: [{ type: 'text' as const, text: t }], isError } })
  on('mcp.call', ($: unknown, e: { tool: string; args: Record<string, any> }) => {
    // Like Studio: an empty studio_id is refused, a missing one picks the open studio.
    if (e.args.studio_id === '') return text('Invalid studio_id', true)
    if (e.tool === 'list_roblox_studios') return text('{"studios":[{"id":"s1","name":"test (placeId: 1)"}]}')
    if (e.tool === 'get_studio_state') return text('- Current Studio Mode: Edit')
    if (e.tool === 'inspect_instance') {
      const props = objects.get(e.args.path)
      return props === undefined ? text('Instance not found', true) : text(JSON.stringify({ path: e.args.path, properties: props }))
    }
    if (e.tool === 'script_read') {
      // A read the test marks as failing: Studio answers an error, not "not found".
      scriptReads += 1
      if (scriptReads === failingRead) return text('Studio did not answer in time', true)
      const source = scripts.get(e.args.target_file)
      return source === undefined ? text('Script not found at path', true) : text(numbered(source))
    }
    if (e.tool === 'multi_edit') {
      const edit = e.args.edits[0]
      scripts.set(e.args.file_path, (scripts.get(e.args.file_path) ?? '').replace(edit.old_string, edit.new_string))
      return text('ok')
    }
    if (e.tool === 'script_grep') {
      const lines: string[] = []
      for (const [path, source] of scripts) {
        source.split('\n').forEach((line, i) => {
          if (line.includes(e.args.query)) lines.push(`Path: ${path.replace(/^game\./, '')} | Line: ${i + 1} | ${line}`)
        })
      }
      return text(lines.join('\n'))
    }
    return text('unknown', true)
  })
  on('tool.call', ($: unknown, e: any) => {
    const tool = String(e.tool)
    if (tool.endsWith('__start_stop_play')) return { result: 'ok' as never, text: 'ok' }
    if (tool.endsWith('__get_console_output')) return { result: 'ok' as never, text: consoleOutput }
    if (tool.endsWith('__execute_luau')) {
      // The fake runs one kind of Luau: `workspace.X.Prop = value`.
      const set = /workspace\.(\w+)\.(\w+)\s*=\s*(.+)$/.exec(String(e.code))
      if (set !== null) {
        const path = `Workspace.${set[1]}`
        objects.set(path, { ...(objects.get(path) ?? {}), [set[2]!]: set[3]!.trim() === 'true' ? true : set[3]!.trim() })
      }
      return { result: 'ok' as never, text: 'nil' }
    }
    if (tool.endsWith('__script_read')) {
      const source = scripts.get(e.target_file) ?? ''
      return { result: 'ok' as never, text: numbered(source) }
    }
    const edit = e.edits[0]
    scripts.set(e.file_path, (scripts.get(e.file_path) ?? '').replace(edit.old_string, edit.new_string))
    return { result: 'ok' as never }
  })
}

test('an edit against a copy a collaborator changed since is refused until Claude reads again', async ($, on) => {
  const scripts = new Map([[PATH, 'local Shop = {}\nShop.price = 5\nreturn Shop']])
  fakeStudio(on, scripts)
  const edit = {
    tool: EDIT,
    studio_id: 's1',
    datamodel_type: 'Edit',
    file_path: PATH,
    edits: [{ old_string: 'Shop.price = 5', new_string: 'Shop.price = 10' }],
  } as never

  await $.tool.call({ tool: READ, studio_id: 's1', target_file: PATH } as never)
  scripts.set(PATH, 'local Shop = {}\nShop.price = 5\nShop.sale = true\nreturn Shop')

  const refused = await $.tool.call(edit)
  expect(refused.deny).toContain('changed after you last read it')
  expect(scripts.get(PATH)).toContain('Shop.price = 5')

  await $.tool.call({ tool: READ, studio_id: 's1', target_file: PATH } as never)
  const ran = await $.tool.call(edit)
  expect(ran.deny).toBeUndefined()
  expect(scripts.get(PATH)).toBe('local Shop = {}\nShop.price = 10\nShop.sale = true\nreturn Shop')

  // Claude's own edit does not make its next edit stale.
  const again = await $.tool.call({
    tool: EDIT,
    studio_id: 's1',
    datamodel_type: 'Edit',
    file_path: PATH,
    edits: [{ old_string: 'Shop.price = 10', new_string: 'Shop.price = 12' }],
  } as never)
  expect(again.deny).toBeUndefined()
})

test('multi_edit carries the Team Create and Luau notes in its description', async ($, on) => {
  on('tool.describe', ($, e) => ({ description: 'Makes multiple edits to a single script.', tool: e.tool }) as never)
  const described = await $.tool.describe({ tool: EDIT, description: 'Makes multiple edits to a single script.' } as never)
  expect(described.description).toContain('Makes multiple edits')
  expect(described.description).toContain('Team Create')
})

test('undo refuses to overwrite a later change by a teammate, unless forced', async ($, on) => {
  const scripts = new Map([[PATH, 'local Shop = {}\nreturn Shop']])
  fakeStudio(on, scripts)

  await $.tool.call({
    tool: EDIT,
    studio_id: 's1',
    datamodel_type: 'Edit',
    file_path: PATH,
    edits: [{ old_string: 'return Shop', new_string: 'Shop.price = 5\nreturn Shop' }],
  } as never)
  scripts.set(PATH, scripts.get(PATH)! + '\n-- teammate note')

  const refused = await $.command.run({ command: 'roclaude', args: 'undo' } as never)
  expect(refused.text).toContain('changed after Claude')
  expect(scripts.get(PATH)).toContain('teammate note')

  const forced = await $.command.run({ command: 'roclaude', args: 'undo force' } as never)
  expect(forced.text).toContain('Restored')
  expect(scripts.get(PATH)).toBe('local Shop = {}\nreturn Shop')
})

test('/roclaude remotes audits the open place', async ($, on) => {
  const scripts = new Map([
    ['game.ServerScriptService.Shop', 'Buy.OnServerEvent:Connect(function(player, item)\n  give(player, item)\nend)'],
    ['game.ServerScriptService.Admin', 'Kick.OnServerEvent:Connect(function(player, who)\n  if not isAdmin(player) then return end\nend)'],
  ])
  fakeStudio(on, scripts)
  on('ui.open', () => ({ value: undefined }) as never)

  const ran = await $.command.run({ command: 'roclaude', args: 'remotes' } as never)
  expect(ran.text).toContain("2 server handler(s) in the game's own scripts, 1 unchecked")
  expect(ran.text).toContain('[unchecked] ServerScriptService.Shop:1 Buy uses item unchecked')
  expect(ran.text).toContain('[gated] ServerScriptService.Admin:1 Kick')
})

test('third-party admin kits and packages are reported apart', () => {
  expect(isVendor("ServerScriptService.Kohl's Admin.Loader.MainModule")).toBe(true)
  expect(isVendor('ReplicatedStorage.Packages._Index.sleitnick_knit')).toBe(true)
  expect(isVendor('src/shared/Packages/Promise.luau')).toBe(true)
  expect(isVendor('ServerScriptService.CmdrAuthCheck')).toBe(false)
  expect(isVendor('ServerScriptService.AdminController')).toBe(false)
})

const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 3 },
} as never
const call = (tool: string, args: Record<string, unknown>) =>
  ({ tool: `mcp__Roblox_Studio__${tool}`, studio_id: 's1', ...args }) as never

test('the band follows changes, playtests and their errors on every surface', async ($, on) => {
  const scripts = new Map([[PATH, 'local Shop = {}\nreturn Shop']])
  fakeStudio(on, scripts)

  // A script edit and a world change: two untested changes.
  await $.tool.call(
    call('multi_edit', {
      datamodel_type: 'Edit',
      file_path: PATH,
      edits: [{ old_string: 'return Shop', new_string: 'Shop.open = true\nreturn Shop' }],
    }),
  )
  await $.tool.call(call('execute_luau', { datamodel_type: 'Edit', code: 'workspace.Part.Anchored = true' }))
  await $.tool.call(call('execute_luau', { datamodel_type: 'Edit', code: 'return workspace.Part.Position' }))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'roclaude', surface, ...(BAND as object) } as never)
    expect(await ui.find({ text: /^2 untested$/ })).toBeDefined()
    expect(await ui.find({ key: 'test' })).toBeDefined()
    expect(await ui.find({ key: 'undo' })).toBeDefined()
    await ui.unmount()
  }

  // A playtest whose Output shows an error, then back to Edit.
  consoleOutput = "ServerScriptService.Shop:2: attempt to index nil with 'open'"
  await $.tool.call(call('start_stop_play', { is_start: true }))
  await $.tool.call(call('get_console_output', {}))
  await $.tool.call(call('start_stop_play', { is_start: false }))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'roclaude', surface, ...(BAND as object) } as never)
    expect(await ui.find({ text: /^1 error$/ })).toBeDefined()
    expect(await ui.find({ text: /untested/ })).toBeUndefined()
    expect(await ui.find({ key: 'test' })).toBeUndefined()
    await ui.unmount()
  }
})

test('reads Studio mode and tells changes from reads', () => {
  expect(studioMode('- Current Studio Mode: Edit\n- Available DataModels: Edit')).toBe('edit')
  expect(studioMode('- Current Studio Mode: Play')).toBe('play')
  expect(changesPlace('workspace.Part.Color = Color3.new(1, 0, 0)')).toBe(true)
  expect(changesPlace('local p = Instance.new("Part")')).toBe(true)
  expect(changesPlace('workspace.Old:Destroy()')).toBe(true)
  expect(changesPlace('return workspace.Part.Position')).toBe(false)
  expect(changesPlace('if a.Value == 1 then return 1 end')).toBe(false)
})

test('the activity pane shows what Claude read and changed, on every surface', async ($, on) => {
  const scripts = new Map([[PATH, 'local Shop = {}\nreturn Shop']])
  fakeStudio(on, scripts)
  on('ui.open', () => ({ value: undefined }) as never)

  await $.tool.call(call('script_read', { target_file: PATH }))
  await $.tool.call(
    call('multi_edit', {
      datamodel_type: 'Edit',
      file_path: PATH,
      edits: [{ old_string: 'return Shop', new_string: 'Shop.open = true\nreturn Shop' }],
    }),
  )
  await $.tool.call(call('execute_luau', { datamodel_type: 'Edit', code: 'workspace.Part.Color = Color3.new(1, 0, 0)' }))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'roclaude',
      surface,
      component: 'Pane',
      requestId: 'roclaude-activity',
      props: { bodyColumns: 50 },
    } as never)
    expect(await ui.find({ text: /Claude edited 1 script, changed 1 object/ })).toBeDefined()
    expect(await ui.find({ text: /Edited/ })).toBeDefined()
    expect(await ui.find({ text: /Changed/ })).toBeDefined()
    expect(await ui.find({ text: /ServerScriptService/ })).toBeDefined()
    expect(await ui.find({ key: 'undo-last' })).toBeDefined()
    await ui.unmount()
  }
})

const PANE = { component: 'Pane', requestId: 'roclaude-activity', props: { bodyColumns: 60 } }

test('the activity view replays each change: diffs, properties, selection, Prev and Next', async ($, on) => {
  const scripts = new Map([[PATH, 'local Shop = {}\nreturn Shop']])
  objects.set('Workspace.Part', { Anchored: false, Color: '0.5, 0.5, 0.5', UniqueId: 'a' })
  fakeStudio(on, scripts)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)

  const edit = (from: string, to: string) =>
    $.tool.call(call('multi_edit', { datamodel_type: 'Edit', file_path: PATH, edits: [{ old_string: from, new_string: to }] }))
  await edit('return Shop', 'Shop.open = true\nreturn Shop')
  await edit('Shop.open = true', 'Shop.open = false')
  await $.tool.call(call('execute_luau', { datamodel_type: 'Edit', code: 'workspace.Part.Anchored = true' }))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'roclaude', surface, ...PANE } as never)
    // The latest change is shown first: the part, as properties before → after.
    expect(await ui.find({ text: /CHANGE 2 OF 2/ })).toBeDefined()
    expect(await ui.find({ text: /^Anchored$/ })).toBeDefined()
    expect(await ui.find({ text: /^true$/ })).toBeDefined()
    expect(await ui.find({ text: /UniqueId/ })).toBeUndefined()

    // Prev goes to the script: one diff over both edits.
    await ui.press({ key: 'prev' })
    expect(await ui.find({ text: /CHANGE 1 OF 2/ })).toBeDefined()
    expect(await ui.find({ type: 'Code' })).toBeDefined()
    expect(await ui.find({ text: /over 2 edits/ })).toBeDefined()

    // A row picks its change directly.
    await ui.press({ key: 'pick-Workspace.Part' })
    expect(await ui.find({ text: /CHANGE 2 OF 2/ })).toBeDefined()
    await ui.unmount()
  }
})

test('where no pane can be placed, /roclaude activity draws a live card in the chat', async ($, on) => {
  const scripts = new Map([[PATH, 'local Shop = {}\nreturn Shop']])
  fakeStudio(on, scripts)
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'this surface places no panes' } }) as never)
  on('ui.panes', () => ({ value: [] }) as never)
  mock.clock(on)

  await $.tool.call(
    call('multi_edit', { datamodel_type: 'Edit', file_path: PATH, edits: [{ old_string: 'return Shop', new_string: 'return Shop -- x' }] }),
  )
  const first = await $.command.run({ command: 'roclaude', args: 'activity' } as never)
  const second = await $.command.run({ command: 'roclaude', args: 'activity' } as never)
  expect(first.text).toBe('roclaude activity #1')
  expect(second.text).toBe('roclaude activity #2')

  const card = (text: string) => ({ component: 'CommandOutput', props: { command: 'roclaude', args: 'activity', text, isErrored: false } })
  for (const surface of ['terminal', 'desktop'] as const) {
    const live = await $.ui.mount({ plugin: 'roclaude', surface, ...card(second.text ?? "") } as never)
    expect(await live.find({ text: /CLAUDE TOUCHED/ })).toBeDefined()
    expect(await live.find({ type: 'Code' })).toBeDefined()
    await live.unmount()

    const old = await $.ui.mount({ plugin: 'roclaude', surface, ...card(first.text ?? "") } as never)
    expect(await old.find({ text: /a newer card is below/ })).toBeDefined()
    await old.unmount()
  }
})

test('where a pane can be placed, /roclaude activity opens it', async ($, on) => {
  fakeStudio(on, new Map())
  mock.clock(on)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  const ran = await $.command.run({ command: 'roclaude', args: 'activity' } as never)
  expect(ran.text).toContain('open beside the conversation')
})

test('an edit Claude makes without a studio_id is still saved for undo and diffed', async ($, on) => {
  const scripts = new Map([[PATH, 'local Shop = {}\nreturn Shop']])
  fakeStudio(on, scripts)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)

  await $.tool.call({
    tool: EDIT,
    datamodel_type: 'Edit',
    file_path: PATH,
    edits: [{ old_string: 'return Shop', new_string: 'Shop.open = true\nreturn Shop' }],
  } as never)

  const listed = await $.command.run({ command: 'roclaude', args: 'history' } as never)
  expect(listed.text).toContain('ServerScriptService.Shop')
  const ui = await $.ui.mount({ plugin: 'roclaude', surface: 'desktop', ...PANE } as never)
  expect(await ui.find({ type: 'Code' })).toBeDefined()
  expect(await ui.find({ key: 'undo-last' })).toBeDefined()
  await ui.unmount()
})

// The mod reads a script before Claude's multi_edit (read 1) and right after
// it (read 2); these tests make read 2 fail, then a teammate edits the script.
test('undo refuses when the script could not be read right after the edit', async ($, on) => {
  const scripts = new Map([[PATH, 'local price = 5']])
  fakeStudio(on, scripts)
  scriptReads = 0
  failingRead = 2

  await $.tool.call(
    call('multi_edit', { datamodel_type: 'Edit', file_path: PATH, edits: [{ old_string: 'local price = 5', new_string: 'local price = 10' }] }),
  )
  failingRead = -1
  scripts.set(PATH, 'local price = 10\n-- teammate line')

  const refused = await $.command.run({ command: 'roclaude', args: 'undo' } as never)
  expect(refused.text).toContain('could not be read right after')
  expect(scripts.get(PATH)).toBe('local price = 10\n-- teammate line')

  const forced = await $.command.run({ command: 'roclaude', args: 'undo force' } as never)
  expect(forced.text).toContain('Restored')
  expect(scripts.get(PATH)).toBe('local price = 5')
})

test('undo of a created script refuses when it could not be read right after creation', async ($, on) => {
  const created = 'game.ServerScriptService.NewThing'
  const scripts = new Map<string, string>()
  fakeStudio(on, scripts)
  scriptReads = 0
  failingRead = 2

  await $.tool.call(
    call('multi_edit', {
      datamodel_type: 'Edit',
      file_path: created,
      className: 'Script',
      edits: [{ old_string: '', new_string: 'print("new")' }],
    }),
  )
  failingRead = -1
  scripts.set(created, 'print("new")\n-- teammate line')

  const refused = await $.command.run({ command: 'roclaude', args: 'undo' } as never)
  expect(refused.text).toContain('could not be read right after')
  expect(scripts.get(created)).toBe('print("new")\n-- teammate line')
})
