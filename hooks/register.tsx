import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { PropMap, RemoteReport, Snapshot, StudioInfo, TouchAction, TouchedItem } from '../types'
import { firstSentence, lineDiff } from './diff'
import {
  leafOf,
  normalizePath,
  parseProps,
  pathsChanged,
  propChanges,
  serviceOf,
  settle,
  summarize,
  touch,
} from './activity'
import { auditRemotes, formatIssues, lintLuau, scanRemotes } from './lint'
import {
  changesPlace,
  countErrors,
  dangersIn,
  GREP_CAP,
  grepScripts,
  isVendor,
  luauLookup,
  saysPlaying,
  scriptKey,
  stillAsSeen,
  stripLineNumbers,
  studioId,
  studioMode,
  studioName,
  studioTool,
  teamFrom,
  writesScripts,
} from './studio'
import type { SeenText } from './studio'

const lastLint = atom({ plugin: 'roclaude', key: 'lastLint' } as const, null)
const isHidden = atom({ plugin: 'roclaude', key: 'isHidden' } as const, false)
const studio = atom({ plugin: 'roclaude', key: 'studio' } as const, null)
const history = atom({ plugin: 'roclaude', key: 'history' } as const, [])
const remotes = atom({ plugin: 'roclaude', key: 'remotes' } as const, null)
const team = atom({ plugin: 'roclaude', key: 'team' } as const, [])
const staleBlocks = atom({ plugin: 'roclaude', key: 'staleBlocks' } as const, 0)
const touched = atom({ plugin: 'roclaude', key: 'touched' } as const, [])
const isWorking = atom({ plugin: 'roclaude', key: 'isWorking' } as const, false)
const turnNo = atom({ plugin: 'roclaude', key: 'turn' } as const, 0)
const selected = atom({ plugin: 'roclaude', key: 'selected' } as const, null)
const cardRun = atom({ plugin: 'roclaude', key: 'cardRun' } as const, 0)

const MAX_SNAPSHOTS = 50
const STUDIO_TOOL = /^mcp__.*(roblox|studio).*__[a-z_]+$/i
const DEFAULT_SERVER = 'Roblox_Studio'
const REMOTES_PANE = 'roclaude-remotes'
const ACTIVITY_PANE = 'roclaude-activity'
// The Studio tools roclaude calls itself through $.mcp.call.
const OWN_CALLS = new Set([
  'list_roblox_studios',
  'get_studio_state',
  'inspect_instance',
  'script_grep',
  'script_read',
  'multi_edit',
  'execute_luau',
])
const NO_STUDIO: StudioInfo = { name: null, server: null, id: null, errors: null, mode: null, untested: 0 }
const POLL_MS = 10_000
// At most this many objects per execute_luau get a before → after record.
const MAX_INSPECT = 5
const TEST_PROMPT =
  'Playtest the open place: start it with start_stop_play, give it a few seconds, read get_console_output, stop play, then fix any errors you find and tell me what you changed.'

// A studio_id argument, or none when no studio is known yet.
const withStudio = (sid: string) => (sid === '' ? {} : { studio_id: sid })

const textOf = (content: readonly { type: string; text?: string }[]) =>
  content.map(block => (block.type === 'text' ? (block.text ?? '') : '')).join('')
const shortName = (path: string) => path.split('.').pop() ?? path

// Reads a script through the Studio MCP server: its source, null when it
// does not exist yet, undefined when it could not be read.
async function readScript(
  $: EngineInterface,
  server: string,
  sid: string,
  path: string,
): Promise<string | null | undefined> {
  try {
    const target = path.startsWith('game.') ? path : `game.${path}`
    const res = await $.mcp.call(server, 'script_read', { ...withStudio(sid), target_file: target })
    const text = textOf(res.content)
    if (res.isError) return /Script not found/i.test(text) ? null : undefined
    return stripLineNumbers(text)
  } catch {
    return undefined
  }
}

async function undo($: EngineInterface, isForced: boolean): Promise<string> {
  const list = await read($, history)
  const last = list[list.length - 1]
  if (last === undefined) return 'Nothing to undo: Claude has not edited a Studio script this session.'

  const { server, studioId: sid, path } = last
  const current = await readScript($, server, sid, path)
  if (current === undefined) {
    return `Could not read ${path} to undo it. Is Studio still open and in Edit mode?`
  }
  // In Team Create someone else may have edited the script since: never
  // overwrite that work unless asked to.
  if (!isForced && last.after !== null && current !== null && current !== last.after) {
    return `${path} changed after Claude's edit (by you or a teammate), so undo would discard that work. Run /roclaude undo force to restore Claude's saved copy anyway.`
  }

  let res
  if (last.source === null) {
    if (current === null) {
      await update($, history, all => all.slice(0, -1))
      return `${path} is already gone; dropped that step.`
    }
    const code = [`local s = ${luauLookup(path)}`, 'if s then s:Destroy() end', 'return s ~= nil'].join('\n')
    res = await $.mcp.call(server, 'execute_luau', { ...withStudio(sid), datamodel_type: 'Edit', code })
  } else {
    if (current === last.source) {
      await update($, history, all => all.slice(0, -1))
      return `${path} already matches its saved copy; dropped that step.`
    }
    if (current === null) {
      return `${path} no longer exists, so there is nothing to restore into.`
    }
    res = await $.mcp.call(server, 'multi_edit', {
      ...withStudio(sid),
      datamodel_type: 'Edit',
      file_path: path,
      edits: [{ old_string: current, new_string: last.source }],
    })
  }

  if (res.isError) return `Undo of ${path} failed: ${textOf(res.content).slice(0, 300)}`
  await update($, history, all => all.slice(0, -1))
  return last.source === null
    ? `Undid the creation of ${path} (deleted it).`
    : `Restored ${path} to how it was before Claude's edit.`
}

type Target = {
  path: string
  kind: TouchedItem['kind']
  action: TouchAction
  propsBefore?: PropMap | null
  propsAfter?: PropMap | null
}
let isActivityOpened = false
// What Claude changed in the running turn, for the note when it ends.
const changedThisTurn: string[] = []
const CARD_MARK = 'roclaude activity #'

// Shows the activity view: as a pane where the surface places one, or else
// as a card in the chat (the command's row draws it). Answers the row's text.
async function showActivity($: EngineInterface): Promise<string> {
  const isShown = async () => {
    try {
      return (await $.ui.panes()).some(pane => pane.id === ACTIVITY_PANE && pane.isPlaced)
    } catch {
      return false
    }
  }
  // Open (or bring forward) the pane, but never wait on it for long: a
  // surface may hold the open until it can seat the pane.
  const opening = $.ui.open({ id: ACTIVITY_PANE, title: 'Studio activity' }).then(
    opened => opened.isPlaced,
    () => false,
  )
  const isPlaced = await Promise.race([opening, $.clock.sleep(1_500).then(() => null)])
  if (isPlaced === true || (isPlaced === null && (await isShown()))) {
    return 'Studio activity is open beside the conversation.'
  }
  const run = (await read($, cardRun)) + 1
  await update($, cardRun, () => run)
  return `${CARD_MARK}${run}`
}

// An object's properties through the Studio MCP server: null when it does
// not exist, undefined when they could not be read.
async function inspectProps(
  $: EngineInterface,
  server: string,
  sid: string,
  path: string,
): Promise<PropMap | null | undefined> {
  try {
    const res = await $.mcp.call(server, 'inspect_instance', { ...withStudio(sid), path })
    const text = textOf(res.content)
    if (res.isError) return /not found|no instance|does not exist|could not find/i.test(text) ? null : undefined
    return parseProps(text)
  } catch {
    return undefined
  }
}

// A call on these is starting: show them as being read, edited or changed,
// and open the activity pane the first time Claude touches the place.
async function begin($: EngineInterface, targets: readonly Target[], as: NonNullable<TouchedItem['activeAs']>) {
  if (targets.length === 0) return
  await update($, touched, list =>
    targets.reduce<TouchedItem[]>((all, target) => {
      const known = all.find(one => one.path === normalizePath(target.path))
      return touch(all, { ...target, action: known?.action ?? 'read', isActive: true, activeAs: as })
    }, [...list]),
  )
  if (!isActivityOpened) {
    isActivityOpened = true
    // Where no pane can be placed (an app without side panes, a headless
    // run) this waits unseen; the band's Activity button shows a card instead.
    $.ui.open({ id: ACTIVITY_PANE, title: 'Studio activity' }).catch(() => undefined)
  }
}

// The call ended: record what it did, or only settle the rows when it failed.
// A change becomes the one the activity view shows.
async function finish($: EngineInterface, targets: readonly Target[], isDone: boolean) {
  if (targets.length === 0) return
  await update($, touched, list =>
    targets.reduce<TouchedItem[]>(
      (all, target) =>
        isDone ? touch(all, { ...target, isActive: false, activeAs: null }) : settle(all, target.path),
      [...list],
    ),
  )
  const changes = isDone ? targets.filter(target => target.action !== 'read') : []
  for (const target of changes) {
    const path = normalizePath(target.path)
    if (!changedThisTurn.includes(path)) changedThisTurn.push(path)
  }
  const last = changes[changes.length - 1]
  if (last !== undefined) await update($, selected, () => normalizePath(last.path))
}

// Asks the Studio MCP server which place is open and whether it is playing,
// for the band. Writes only what changed, so an idle poll redraws nothing.
async function probeStudio($: EngineInterface): Promise<void> {
  try {
    const known = await read($, studio)
    const server = known?.server ?? DEFAULT_SERVER
    let { id, name } = known ?? NO_STUDIO
    if (id === null || name === null) {
      const text = textOf((await $.mcp.call(server, 'list_roblox_studios', {})).content)
      id = studioId(text)
      name = studioName(text)
      if (id === null) return
    }
    const sid = id
    const state = await $.mcp.call(server, 'get_studio_state', { studio_id: sid })
    const mode = state.isError ? (known?.mode ?? null) : studioMode(textOf(state.content))

    if (known?.id === sid && known.name === name && known.server === server && known.mode === mode) return
    await update($, studio, info => noteMode({ ...(info ?? NO_STUDIO), server, id: sid, name }, mode))
  } catch {
    // No Studio MCP server, or Studio is closed: the band says not connected.
  }
}

// A playtest that starts counts as testing what came before it.
function noteMode(info: StudioInfo, mode: StudioInfo['mode']): StudioInfo {
  if (mode === 'play' && info.mode !== 'play') return { ...info, mode, untested: 0, errors: null }
  return { ...info, mode }
}

// Audits every RemoteEvent and RemoteFunction handler in the open place.
async function scanStudio($: EngineInterface): Promise<RemoteReport | string> {
  const seen = await read($, studio)
  const server = seen?.server ?? DEFAULT_SERVER
  let id = seen?.id ?? null
  try {
    // A server that just started needs a few seconds before Studio registers.
    for (let attempt = 0; id === null && attempt < 4; attempt += 1) {
      if (attempt > 0) await $.clock.sleep(2_000)
      const listed = await $.mcp.call(server, 'list_roblox_studios', {})
      id = studioId(textOf(listed.content))
    }
    if (id === null) return 'No Roblox Studio is connected. Open your place with the MCP server enabled in Assistant settings.'

    const grep = await $.mcp.call(server, 'script_grep', { studio_id: id, query: 'OnServer' })
    if (grep.isError) return `Could not search the place's scripts: ${textOf(grep.content).slice(0, 200)}`
    const found = grepScripts(textOf(grep.content))

    const handlers: RemoteReport['handlers'][number][] = []
    for (const script of found.scripts) {
      const source = await readScript($, server, id, script)
      if (typeof source !== 'string') continue
      handlers.push(...scanRemotes(source).map(handler => ({ ...handler, script, isVendor: isVendor(script) })))
    }

    return {
      scripts: found.scripts.length,
      handlers,
      note:
        found.matches >= GREP_CAP
          ? `Studio's script search stops at ${GREP_CAP} matches, so some handlers may be missing.`
          : null,
    }
  } catch (error) {
    return `Could not reach the Roblox Studio MCP server "${server}": ${error instanceof Error ? error.message : String(error)}`
  }
}

const STATUS_ORDER = { unchecked: 0, gated: 1, checked: 2, 'no-args': 3 } as const

// The game's own handlers, worst first, and the third-party ones apart.
function orderHandlers(report: RemoteReport) {
  const sorted = [...report.handlers].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status])
  const own = sorted.filter(handler => !handler.isVendor)
  const vendor = sorted.filter(handler => handler.isVendor)
  const bad = own.filter(handler => handler.status === 'unchecked').length
  return { own, vendor, bad }
}

function remotesText(report: RemoteReport): string {
  const { own, vendor, bad } = orderHandlers(report)
  const row = (handler: RemoteReport['handlers'][number]) =>
    `  [${handler.status}] ${handler.script}:${handler.line} ${handler.remote}${handler.unchecked.length > 0 ? ` uses ${handler.unchecked.join(', ')} unchecked` : ''}`
  return [
    `RemoteEvent audit: ${own.length} server handler(s) in the game's own scripts, ${bad} unchecked.`,
    ...own.map(row),
    ...(vendor.length === 0
      ? []
      : [`Third-party modules (${vendor.length} handler(s); review or update them upstream):`, ...vendor.map(row)]),
    ...(report.note === null ? [] : [report.note]),
  ].join('\n')
}

const CONVENTIONS = [
  '',
  'roclaude notes for editing this place:',
  '- Create and change scripts only with multi_edit (new scripts: className plus a first edit with an empty old_string), and read them with script_read. roclaude refuses execute_luau code that writes script source (.Source =, UpdateSourceAsync, Instance.new of a script), because only multi_edit edits can be undone, reviewed and kept safe in Team Create.',
  '- Read a script in full with script_read before you edit it. In Team Create collaborators may be editing too: if a script changed since you last read it, roclaude refuses the edit and you must read it again first.',
  '- Use the task library (task.wait, task.spawn, task.defer, task.delay), never the deprecated wait, spawn or delay. Get services with game:GetService("Name"); use PascalCase methods.',
  '- The server never trusts what a client sends through a RemoteEvent or RemoteFunction: check types with typeof, ranges, rate and ownership. Luau type annotations are not runtime checks.',
  '- Wrap DataStore, HttpService and MarketplaceService calls in pcall. Players.LocalPlayer exists only on the client.',
  '- After changing scripts, playtest (start_stop_play), read get_console_output, stop, and fix errors before saying you are done. The person can undo your edits with /roclaude undo.',
].join('\n')

const EXECUTE_NOTE = [
  '',
  'roclaude: do not use this tool to read or write script source. Read scripts with script_read; create and change them with multi_edit. Code that writes source (.Source =, UpdateSourceAsync, Instance.new of a Script, LocalScript or ModuleScript) is refused.',
].join('\n')

const SCRIPT_WRITE_REFUSAL =
  'roclaude: this Luau writes script source. Create or change scripts with multi_edit instead (for a new script: file_path like game.ServerScriptService.Name, className Script, LocalScript or ModuleScript, and a first edit with old_string "" holding the source). multi_edit edits can be undone with /roclaude undo, are reviewed for exploits, and are kept safe for Team Create collaborators.'

// The activity view: what Claude touched, each row clickable, and the
// selected change below it, a script's diff or an object's properties.
async function drawActivity($: EngineInterface, e: Parameters<EngineInterface['ui']['resolve']>[0], width: number) {
  const { Box, Button, Code, Text } = $.ui.resolve(e)
  const list = await read($, touched)
  const working = await read($, isWorking)
  const snapshots = await read($, history)
  const { title, detail } = summarize(list)
  const isBusy = working || list.some(one => one.isActive)

  const color = { read: 'merged', edited: 'claude', created: 'success', changed: 'suggestion' } as const
  const label = { read: 'Read', edited: 'Edited', created: 'Created', changed: 'Changed' } as const
  const status = isBusy ? 'WORKING' : list.length > 0 ? 'DONE' : 'IDLE'
  const statusColor = isBusy ? 'warning' : list.length > 0 ? 'claude' : 'inactive'

  const changes = list.filter(one => one.action !== 'read')
  const chosen = (await read($, selected)) ?? changes[changes.length - 1]?.path ?? null
  const current = list.find(one => one.path === chosen) ?? null
  const at = current === null ? -1 : changes.findIndex(one => one.path === current.path)
  const pick = (path: string) => update($, selected, () => path)

  const services: string[] = []
  for (const one of list) if (!services.includes(serviceOf(one.path))) services.push(serviceOf(one.path))

  // The selected item's change.
  let body = <Text dimColor>Select something Claude touched to see what changed.</Text>
  if (current !== null && current.kind === 'script') {
    const edits = snapshots.filter(one => normalizePath(one.path) === current.path && one.after !== null)
    const first = edits[0]
    const last = edits[edits.length - 1]
    if (current.action === 'read' || first === undefined || last === undefined) {
      body = <Text dimColor>Claude read this script and did not change it.</Text>
    } else {
      const diff = lineDiff(first.source, last.after ?? '')
      body = (
        <Box flexDirection="column">
          <Text>
            <Text color="success">+{diff.added}</Text> <Text color="error">−{diff.removed}</Text>
            <Text dimColor>
              {' '}
              over {edits.length} edit{edits.length === 1 ? '' : 's'}
            </Text>
          </Text>
          <Box borderStyle="round" borderColor="inactive">
            {diff.unified === '' ? (
              <Text dimColor>No line changes.</Text>
            ) : (
              <Code key={`diff-${current.path}`} source={diff.unified} format="diff" language="lua" path={leafOf(current.path)} />
            )}
          </Box>
        </Box>
      )
    }
  } else if (current !== null) {
    const { propsBefore: before, propsAfter: after } = current
    if (current.action === 'read') body = <Text dimColor>Claude looked at this object and did not change it.</Text>
    else if (before === undefined && after === undefined) {
      body = <Text dimColor>Claude changed this with Luau; its properties could not be read.</Text>
    } else if (after === null) body = <Text color="error">Deleted.</Text>
    else if (before === null || before === undefined) body = <Text color="success">Created by Claude.</Text>
    else {
      const rows = after === undefined ? [] : propChanges(before, after)
      body =
        rows.length === 0 ? (
          <Text dimColor>No property changes seen.</Text>
        ) : (
          <Box flexDirection="column" borderStyle="round" borderColor="inactive" paddingX={1}>
            {rows.slice(0, 12).map(row => (
              <Box key={`prop-${row.name}`} justifyContent="space-between" gap={2}>
                <Text dimColor>{row.name}</Text>
                <Text wrap="truncate-start">
                  <Text color="error">{row.before}</Text>
                  <Text dimColor> → </Text>
                  <Text color="success">{row.after}</Text>
                </Text>
              </Box>
            ))}
            {rows.length > 12 && <Text dimColor>…and {rows.length - 12} more</Text>}
          </Box>
        )
    }
  }

  return (
    <Box flexDirection="column" width={width}>
      <Box borderStyle="round" borderColor={isBusy ? 'warning' : 'inactive'} paddingX={1} flexDirection="column">
        <Text bold color={statusColor}>
          {status}
        </Text>
        <Text bold>{title}</Text>
        {detail !== '' && <Text dimColor>{detail}</Text>}
      </Box>

      <Box justifyContent="space-between" marginTop={1}>
        <Text bold dimColor>
          CLAUDE TOUCHED
        </Text>
        <Text bold dimColor>
          {list.length} {list.length === 1 ? 'ITEM' : 'ITEMS'}
        </Text>
      </Box>
      {list.length === 0 && <Text dimColor>Scripts and objects Claude reads or changes in Studio show up here.</Text>}
      {services.map(service => (
        <Box flexDirection="column" key={`svc-${service}`}>
          <Text dimColor>{service}</Text>
          {list
            .filter(one => serviceOf(one.path) === service)
            .map(one => {
              const isChosen = current?.path === one.path
              const where = normalizePath(one.path).split('.').slice(1, -1).join('.')
              const badge = one.isActive ? (one.activeAs === 'reading' ? 'merged' : 'claude') : color[one.action]
              return (
                <Box
                  key={`row-${one.path}`}
                  justifyContent="space-between"
                  alignItems="center"
                  gap={1}
                  paddingLeft={1}
                  backgroundColor={isChosen ? 'subtle' : undefined}
                >
                  <Box gap={1} flexShrink={1} alignItems="center">
                    <Text bold color={one.kind === 'script' ? 'suggestion' : 'success'}>
                      {one.kind === 'script' ? 'LUA' : 'OBJ'}
                    </Text>
                    <Button key={`pick-${one.path}`} label={leafOf(one.path)} plain onPress={() => pick(one.path)} />
                    {where !== '' && (
                      <Text dimColor wrap="truncate-end">
                        {where}
                      </Text>
                    )}
                  </Box>
                  <Box flexShrink={0} paddingX={1} backgroundColor={badge}>
                    <Text bold color="inverseText">
                      {one.isActive ? `${one.activeAs}…` : label[one.action]}
                    </Text>
                  </Box>
                </Box>
              )
            })}
        </Box>
      ))}

      {current !== null && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color="claude">
            {at >= 0 ? `CHANGE ${at + 1} OF ${changes.length}` : 'READ ONLY'}
          </Text>
          <Text bold>{leafOf(current.path)}</Text>
          <Text dimColor>
            {current.path} · {label[current.action]}
          </Text>
        </Box>
      )}
      <Box marginTop={current === null ? 1 : 0}>{body}</Box>

      <Box marginTop={1} gap={1}>
        {changes.length > 1 && (
          <>
            <Button key="prev" label="Prev" onPress={() => pick(changes[Math.max(0, at - 1)]!.path)} />
            <Button
              key="next"
              label="Next"
              variant="primary"
              onPress={() => pick(changes[Math.min(changes.length - 1, at + 1)]!.path)}
            />
          </>
        )}
        {snapshots.length > 0 && (
          <Button
            key="undo-last"
            label="Undo last edit"
            onPress={async () => {
              $.ui.toast(await undo($, false))
            }}
          />
        )}
        {list.length > 0 && !isBusy && (
          <Button
            key="clear"
            label="Clear"
            onPress={async () => {
              await update($, touched, () => [])
              await update($, selected, () => null)
            }}
          />
        )}
      </Box>
    </Box>
  )
}

export const register: Register = on => {
  let nudgedThisTurn = false
  // What Claude last read of each script, to catch edits against a stale copy.
  const seenText = new Map<string, SeenText>()

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'roclaude',
      description: 'Roblox Studio: audit RemoteEvents, undo Claude’s edits, Team Create status',
      argumentHint: '[activity|remotes|undo|history|show|hide]',
    })
    // Find the open place once the MCP server has had a moment to start.
    $.clock.after(3_000, () => void probeStudio($))
    $.clock.every(POLL_MS, () => void probeStudio($))
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    nudgedThisTurn = false
    changedThisTurn.length = 0
    await update($, isWorking, () => true)
    await update($, turnNo, n => n + 1)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    await update($, isWorking, () => false)
    await update($, touched, list => (list.some(one => one.isActive) ? list.map(one => ({ ...one, isActive: false, activeAs: null })) : list))

    // A turn that changed the place: say so in the transcript, with how to look.
    if (changedThisTurn.length > 0) {
      const names = changedThisTurn.map(leafOf)
      const shown = names.slice(0, 4).join(' · ') + (names.length > 4 ? ` +${names.length - 4}` : '')
      $.session
        .append({
          message: {
            type: 'system',
            content: [
              {
                type: 'text',
                text: `Studio activity · Claude changed ${names.length} thing${names.length === 1 ? '' : 's'}: ${shown}\nClaude: ${firstSentence(e.answer)}\nPress Activity above the prompt, or type /roclaude activity, to see each change.`,
              },
            ],
          },
        })
        .catch(() => undefined)
    }
    return next(e)
  })

  // Claude reads the notes where it needs them: in multi_edit's description.
  on('tool.describe', { tool: STUDIO_TOOL }, async ($, e, next) => {
    const described = await next(e)
    const name = studioTool(e.tool)?.name
    if (name === 'multi_edit') return { ...described, description: described.description + CONVENTIONS }
    if (name === 'execute_luau') return { ...described, description: described.description + EXECUTE_NOTE }
    return described
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: STUDIO_TOOL }, async ($, e, next) => {
    const found = studioTool(e.tool)
    if (found === null) return next(e)
    const args = e as unknown as Record<string, unknown>
    const usedId = typeof args.studio_id === 'string' ? args.studio_id : null

    const known = await read($, studio)
    if (known === null || known.server !== found.server || (usedId !== null && known.id !== usedId)) {
      await update($, studio, info => ({ ...(info ?? NO_STUDIO), server: found.server, id: usedId ?? info?.id ?? null }))
    }

    if (found.name === 'get_studio_state') {
      const ran = await next(e)
      const mode = ran.deny === undefined && ran.isError !== true ? studioMode(ran.text ?? '') : null
      if (mode !== null) await update($, studio, info => noteMode(info ?? NO_STUDIO, mode))
      return ran
    }

    if (found.name === 'start_stop_play') {
      const ran = await next(e)
      if (ran.deny === undefined && ran.isError !== true) {
        await update($, studio, info => noteMode(info ?? NO_STUDIO, args.is_start === true ? 'play' : 'edit'))
      }
      return ran
    }

    if (found.name === 'execute_luau') {
      const code = typeof args.code === 'string' ? args.code : ''
      const paths = args.datamodel_type === 'Edit' && changesPlace(code) ? pathsChanged(code).slice(0, MAX_INSPECT) : []
      const sid = usedId ?? known?.id ?? ''
      await begin(
        $,
        paths.map(path => ({ path, kind: 'instance' as const, action: 'changed' as const })),
        'changing',
      )
      // Each object's properties just before and after, for the before → after view.
      const before = await Promise.all(paths.map(path => inspectProps($, found.server, sid, path)))
      const ran = await next(e)
      const isDone = ran.deny === undefined && ran.isError !== true
      const after = isDone ? await Promise.all(paths.map(path => inspectProps($, found.server, sid, path))) : []
      await finish(
        $,
        paths.map((path, i) => ({
          path,
          kind: 'instance' as const,
          action: before[i] === null && after[i] != null ? ('created' as const) : ('changed' as const),
          propsBefore: before[i],
          propsAfter: after[i],
        })),
        isDone,
      )
      if (ran.isError === true && saysPlaying(ran.text ?? '')) {
        await update($, studio, info => noteMode(info ?? NO_STUDIO, 'play'))
      } else if (ran.deny === undefined && ran.isError !== true && args.datamodel_type === 'Edit' && changesPlace(code)) {
        await update($, studio, info => ({ ...(info ?? NO_STUDIO), untested: (info?.untested ?? 0) + 1 }))
      }
      return ran
    }

    if (found.name === 'list_roblox_studios') {
      const ran = await next(e)
      if (ran.deny === undefined && ran.isError !== true) {
        const name = studioName(ran.text ?? '')
        const id = studioId(ran.text ?? '')
        await update($, studio, info => ({ ...(info ?? NO_STUDIO), name, id: info?.id ?? id }))
      }
      return ran
    }

    if (found.name === 'get_console_output') {
      const ran = await next(e)
      if (ran.deny === undefined && ran.isError !== true) {
        const output = ran.text ?? ''
        await update($, studio, info => ({ ...(info ?? NO_STUDIO), errors: countErrors(output) }))
        await update($, team, members => teamFrom(output, members))
      }
      return ran
    }

    if (found.name === 'script_read') {
      const path = typeof args.target_file === 'string' ? args.target_file : ''
      const reading = path === '' ? [] : [{ path, kind: 'script' as const, action: 'read' as const }]
      await begin($, reading, 'reading')
      const ran = await next(e)
      await finish($, reading, ran.deny === undefined && ran.isError !== true)
      if (ran.deny === undefined && ran.isError !== true && path !== '') {
        const isWhole = args.should_read_entire_file !== false
        const start = isWhole ? 1 : typeof args.start_line_one_indexed === 'number' ? args.start_line_one_indexed : 1
        seenText.set(scriptKey(path), { start, lines: stripLineNumbers(ran.text ?? '').split('\n'), isWhole })
      }
      return ran
    }

    if (found.name === 'inspect_instance' || found.name === 'insert_asset') {
      const isInsert = found.name === 'insert_asset'
      const parent = typeof args.parentPath === 'string' ? args.parentPath : 'Workspace'
      const target = isInsert
        ? `${parent}.${typeof args.assetName === 'string' ? args.assetName : 'Asset'}`
        : typeof args.path === 'string'
          ? args.path
          : ''
      const items =
        target === '' ? [] : [{ path: target, kind: 'instance' as const, action: isInsert ? ('created' as const) : ('read' as const) }]
      await begin($, items, isInsert ? 'changing' : 'reading')
      const ran = await next(e)
      const ok = ran.deny === undefined && ran.isError !== true
      const added = ok && isInsert ? await inspectProps($, found.server, usedId ?? known?.id ?? '', target) : undefined
      await finish($, isInsert ? items.map(item => ({ ...item, propsBefore: null, propsAfter: added })) : items, ok)
      if (ok && isInsert) await update($, studio, info => ({ ...(info ?? NO_STUDIO), untested: (info?.untested ?? 0) + 1 }))
      return ran
    }

    if (found.name !== 'multi_edit') return next(e)

    const path = typeof args.file_path === 'string' ? args.file_path : ''
    const editing = [{ path, kind: 'script' as const, action: 'edited' as const }]
    await begin($, editing, 'editing')
    const sid = usedId ?? known?.id ?? ''
    const before = await readScript($, found.server, sid, path)

    // Team Create: refuse an edit made against a copy someone has since changed.
    const seen = seenText.get(scriptKey(path))
    if (seen !== undefined && typeof before === 'string' && !stillAsSeen(seen, before)) {
      seenText.delete(scriptKey(path))
      await update($, staleBlocks, count => count + 1)
      await finish($, editing, false)
      return {
        deny: `roclaude: ${path} changed after you last read it, likely a Team Create collaborator editing it. Read it again with script_read, then redo your edit on the current version so you don't overwrite their work.`,
      }
    }

    const ran = await next(e)
    if (ran.isError === true && saysPlaying(ran.text ?? '')) {
      await update($, studio, info => noteMode(info ?? NO_STUDIO, 'play'))
    }
    const isEdited = ran.deny === undefined && ran.isError !== true
    await finish($, before === null ? [{ ...editing[0]!, action: 'created' }] : editing, isEdited)
    if (!isEdited) return ran
    await update($, studio, info => ({ ...(info ?? NO_STUDIO), untested: (info?.untested ?? 0) + 1 }))

    const after = before !== undefined ? ((await readScript($, found.server, sid, path)) ?? null) : null
    if (before !== undefined) {
      const turn = await read($, turnNo)
      await update($, history, list => {
        const id = (list[list.length - 1]?.id ?? 0) + 1
        const snapshot: Snapshot = { id, server: found.server, studioId: sid, path, source: before, after, turn }
        return [...list, snapshot].slice(-MAX_SNAPSHOTS)
      })
    }
    if (after !== null) {
      await update($, remotes, report => {
        if (report === null) return report
        const key = scriptKey(path)
        const kept = report.handlers.filter(handler => scriptKey(handler.script) !== key)
        const fresh = scanRemotes(after).map(handler => ({ ...handler, script: key, isVendor: isVendor(key) }))
        if (fresh.length === 0 && kept.length === report.handlers.length) return report
        return { ...report, handlers: [...kept, ...fresh] }
      })
    }
    // Claude knows the script as its own edit left it.
    if (after !== null) seenText.set(scriptKey(path), { start: 1, lines: after.split('\n'), isWhole: true })
    else seenText.delete(scriptKey(path))

    const edits = Array.isArray(args.edits) ? (args.edits as { new_string?: unknown }[]) : []
    const written = edits.map(edit => (typeof edit.new_string === 'string' ? edit.new_string : '')).join('\n')
    const className = typeof args.className === 'string' ? args.className : ''
    const lintPath = className === 'Script' ? `${path}.server.luau` : path
    const issues = [...lintLuau(lintPath, written), ...auditRemotes(written)].map(issue => ({ ...issue, line: 0 }))
    await update($, lastLint, () => ({ file: path, issues }))

    const context = [...(ran.context ?? [])]
    if (issues.length > 0) context.push(formatIssues(path, issues).replace(/^ {2}L0 /gm, '  - '))
    if (!nudgedThisTurn) {
      nudgedThisTurn = true
      context.push(
        'roclaude: you changed a script in the open place. Before you finish, playtest with start_stop_play, read get_console_output, stop play, and fix any errors. The person can undo your edit with /roclaude undo.',
      )
    }

    return { ...ran, context }
  }).catch(($, e, next) => next(e))

  // Ask the person before Luau that deletes, writes player data or loads outside code.
  on('tool.check', { tool: STUDIO_TOOL }, async ($, e, next) => {
    const found = studioTool(e.tool)
    const verdict = await next(e)

    // roclaude's own calls: reads for /roclaude remotes and snapshots, and the
    // restore of a /roclaude undo the person typed. Auto mode's classifier gives
    // no verdict on a plugin's call, so the plugin answers for its own; a deny
    // rule the person wrote in settings still stands.
    if (next.origin.plugin === 'roclaude' && found !== null && OWN_CALLS.has(found.name)) {
      if (verdict.decision === 'deny' && verdict.rule !== undefined) return verdict
      return { decision: 'allow', reason: `roclaude's own ${found.name}` }
    }

    if (found?.name !== 'execute_luau' || verdict.decision === 'deny') return verdict

    const input = e.input as { code?: unknown } | null
    const code = typeof input?.code === 'string' ? input.code : ''
    if (writesScripts(code)) return { decision: 'deny', reason: SCRIPT_WRITE_REFUSAL }

    const dangers = dangersIn(code)
    if (dangers.length === 0) return verdict

    const members = await read($, team)
    const shared = members.length > 1 ? ` Team Create: ${members.join(', ')} will see this change.` : ''
    return {
      decision: 'ask',
      reason: `roclaude: this Luau ${dangers.map(danger => danger.reason).join('; ')}. roclaude cannot undo it.${shared}`,
    }
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'roclaude' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'hide' || arg === 'show') {
      await update($, isHidden, () => arg === 'hide')
      return { text: `roclaude band ${arg === 'hide' ? 'hidden' : 'shown'}.` }
    }
    if (arg === 'undo' || arg === 'undo force') {
      return { text: await undo($, arg === 'undo force') }
    }
    if (arg === 'activity' || arg === 'files' || arg === 'replay') {
      return { text: await showActivity($) }
    }
    if (arg === 'remotes') {
      const report = await scanStudio($)
      if (typeof report === 'string') return { text: report }
      await update($, remotes, () => report)
      await $.ui.open({ id: REMOTES_PANE, title: 'RemoteEvent audit' })
      return { text: remotesText(report) }
    }
    if (arg === 'history') {
      const list = await read($, history)
      if (list.length === 0) return { text: 'No Studio edits by Claude this session.' }
      return {
        text: [
          `Claude's Studio edits this session, newest last (/roclaude undo reverts the newest):`,
          ...list.map(s => `  ${s.id}. ${s.path}${s.source === null ? ' (created)' : ''}`),
        ].join('\n'),
      }
    }

    const seen = await read($, studio)
    if (seen === null) {
      return {
        text: 'roclaude is waiting: Claude has not used the Roblox Studio MCP server this session. Try /roclaude remotes, or ask Claude to look at your place.',
      }
    }
    const lint = await read($, lastLint)
    const list = await read($, history)
    const members = await read($, team)
    const blocks = await read($, staleBlocks)
    return {
      text: [
        `Studio: ${seen.name ?? 'connected'}, ${list.length} script edit(s) saved for undo`,
        `Team Create: ${members.length > 0 ? members.join(', ') : 'no one else seen in Output yet'}${blocks > 0 ? `; ${blocks} stale edit(s) refused` : ''}`,
        `Last playtest output: ${seen.errors === null ? 'not read yet' : `${seen.errors} error line(s)`}`,
        lint === null
          ? 'Last Luau check: none yet.'
          : lint.issues.length === 0
            ? `Last Luau check: ${lint.file} is clean.`
            : formatIssues(lint.file, lint.issues).replace(/^ {2}L0 /gm, '  - '),
      ].join('\n'),
    }
  }).catch(($, e, next) => ({
    // The command answers even when something in it fails, and says what.
    text: `roclaude: /roclaude ${e.args} failed (${next.error.kind}). Try again; if it keeps failing, restart the session.`,
  }))

  on('ui.render', { component: 'Pane', requestId: REMOTES_PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const report = await read($, remotes)
    if (report === null) return <Text dimColor>Run /roclaude remotes to audit this game's RemoteEvents.</Text>

    const { own, vendor, bad } = orderHandlers(report)
    const room = Math.max(3, (e.viewport?.rows ?? 24) - 8)
    const color = { unchecked: 'error', gated: 'warning', checked: 'success', 'no-args': 'inactive' } as const
    const label = { unchecked: 'UNCHECKED', gated: 'admin-only', checked: 'checked', 'no-args': 'no args' } as const
    const unchecked = own
      .filter(handler => handler.status === 'unchecked')
      .map(handler => `- ${handler.script}:${handler.line} ${handler.remote} (uses ${handler.unchecked.join(', ')})`)

    return (
      <Box flexDirection="column">
        <Text>
          <Text bold>{own.length}</Text> handler(s) in the game's scripts ·{' '}
          <Text color={bad > 0 ? 'error' : 'success'}>{bad} unchecked</Text>
          {vendor.length > 0 && <Text dimColor> · {vendor.length} in third-party modules</Text>}
        </Text>
        {own.slice(0, room).map(handler => (
          <Box flexDirection="column">
            <Text wrap="truncate-start">
              <Text color={color[handler.status]}>{label[handler.status].padEnd(10)}</Text> {handler.remote}{' '}
              <Text dimColor>
                {handler.script}:{handler.line}
              </Text>
            </Text>
            {handler.unchecked.length > 0 && (
              <Text dimColor>{'           '}trusts: {handler.unchecked.join(', ')}</Text>
            )}
          </Box>
        ))}
        {own.length > room && <Text dimColor>…and {own.length - room} more (see /roclaude remotes)</Text>}
        {report.note !== null && <Text dimColor>{report.note}</Text>}
        {bad > 0 && (
          <Box>
            <Button
              key="fix"
              label="Ask Claude to fix unchecked"
              onPress={() =>
                $.prompt.submit({
                  text: [
                    'Fix these RemoteEvent handlers that roclaude found using client values unchecked. For each, add a permission check or validate every client value (typeof, ranges, cooldowns, ownership), without changing behavior for legitimate players:',
                    ...unchecked,
                  ].join('\n'),
                })
              }
            />
          </Box>
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: ACTIVITY_PANE }, async ($, e) =>
    drawActivity($, e, e.props.bodyColumns ?? e.viewport?.columns ?? 50),
  )

  // Where no pane can be placed, /roclaude activity draws the view in the chat.
  // Only the newest card is live; older ones point to it.
  on('ui.render', { component: 'CommandOutput', props: { command: 'roclaude' } }, async ($, e, next) => {
    const match = e.props.text.match(/roclaude activity #(\d+)/)
    if (match === null) return next(e)
    const { Text } = $.ui.resolve(e)
    if (Number(match[1]) !== (await read($, cardRun))) return <Text dimColor>Studio activity (a newer card is below).</Text>
    return drawActivity($, e, Math.min(e.viewport?.columns ?? 80, 90))
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const seen = await read($, studio)
    if (e.props.hasSurvey || (await read($, isHidden))) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const width = e.props.bodyColumns ?? e.viewport?.columns ?? 80

    // A filled tag: the band's status words, like a progress label.
    const pill = (key: string, text: string, color: 'warning' | 'success' | 'error' | 'inactive' | 'merged') => (
      <Box key={key} backgroundColor={color} paddingX={1}>
        <Text bold color="inverseText">
          {text}
        </Text>
      </Box>
    )
    const hide = <Button key="hide" label="Hide" plain onPress={() => update($, isHidden, () => true)} />

    if (seen === null) {
      return (
        <Box width={width} justifyContent="space-between" alignItems="center">
          <Box gap={1} alignItems="center">
            <Text color="inactive">●</Text>
            <Text bold>Roblox Studio</Text>
            {pill('state', 'Not connected', 'inactive')}
            <Text dimColor>Open a place with the MCP server on</Text>
          </Box>
          {hide}
        </Box>
      )
    }

    const lint = await read($, lastLint)
    const list = await read($, history)
    const members = await read($, team)
    const report = await read($, remotes)
    const unchecked = report === null ? 0 : orderHandlers(report).bad
    const issues = lint === null ? 0 : lint.issues.length
    const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

    // One colour says how the place is doing: red needs action, yellow a look.
    const errors = seen.untested === 0 ? (seen.errors ?? 0) : 0
    const health = unchecked > 0 || errors > 0 ? 'error' : seen.untested > 0 || issues > 0 ? 'warning' : 'success'

    const left = [
      <Text key="dot" color={health}>
        ●
      </Text>,
      <Text key="name" bold>
        {seen.name ?? 'Roblox Studio'}
      </Text>,
    ]
    if (seen.mode === 'play') left.push(pill('mode', 'Playing', 'merged'))
    else if (seen.mode === 'edit') left.push(pill('mode', 'Edit', 'inactive'))
    if (seen.untested > 0) left.push(pill('result', `${seen.untested} untested`, 'warning'))
    else if (errors > 0) left.push(pill('result', plural(errors, 'error'), 'error'))
    else if (seen.errors !== null) left.push(pill('result', 'Tested', 'success'))
    if (unchecked > 0) {
      left.push(
        <Text key="remotes" color="error">
          {plural(unchecked, 'unchecked remote')}
        </Text>,
      )
    }
    if (issues > 0) {
      left.push(
        <Text key="issues" color="warning">
          {plural(issues, 'issue')} in {shortName(lint?.file ?? '')}
        </Text>,
      )
    }
    if (members.length > 0) {
      left.push(
        <Text key="team" dimColor>
          {members.length <= 2 ? members.join(', ') : plural(members.length, 'collaborator')}
        </Text>,
      )
    }
    if (list.length > 0) {
      left.push(
        <Text key="undoable" dimColor>
          {list.length} undoable
        </Text>,
      )
    }

    const right = []
    if ((await read($, touched)).length > 0) {
      // Runs the command, so the view shows in a pane or, where none can be
      // placed, as a card in the chat.
      right.push(
        <Button
          key="activity"
          label="Activity"
          onPress={() => {
            void $.command.run({ command: 'roclaude', args: 'activity' }).catch(() => undefined)
          }}
        />,
      )
    }
    if (seen.untested > 0 && seen.mode !== 'play') {
      right.push(<Button key="test" label="Test" variant="primary" onPress={() => $.prompt.submit({ text: TEST_PROMPT })} />)
    }
    if (list.length > 0) {
      right.push(
        <Button
          key="undo"
          label="Undo"
          onPress={async () => {
            $.ui.toast(await undo($, false))
          }}
        />,
      )
    }
    right.push(hide)

    return (
      <Box width={width} justifyContent="space-between" alignItems="center">
        <Box gap={1} alignItems="center" flexWrap="wrap" flexShrink={1}>
          {left}
        </Box>
        <Box gap={1} alignItems="center" flexShrink={0}>
          {right}
        </Box>
      </Box>
    )
  })
}
