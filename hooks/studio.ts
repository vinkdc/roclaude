// Pure helpers for the Roblox Studio MCP server's tools.

/** `mcp__Roblox_Studio__multi_edit` → { server: 'Roblox_Studio', name: 'multi_edit' } */
export function studioTool(tool: string): { server: string; name: string } | null {
  const match = /^mcp__(.+?)__([a-z_]+)$/.exec(tool)
  if (match === null || !/roclaude|studio/i.test(match[1] ?? '')) return null
  return { server: match[1] ?? '', name: match[2] ?? '' }
}

/** script_read answers `     1→line`; this gives back the source. */
export function stripLineNumbers(text: string): string {
  return text
    .split('\n')
    .map(line => line.replace(/^\s*\d+→/, ''))
    .join('\n')
}

/** Luau that finds an instance by its dot path (`game.ServerScriptService.Main`). */
export function luauLookup(path: string): string {
  const parts = path.replace(/^game\./, '').split('.')
  const steps = parts.map(part => `:FindFirstChild(${JSON.stringify(part)})`).join('')
  return `game${steps}`
}

const SCRIPT_WRITE =
  /\.Source\s*=(?!=)|UpdateSourceAsync|Instance\.new\s*\(\s*["'](Script|LocalScript|ModuleScript)["']/

/**
 * Whether Luau run in Studio writes or creates script source, which belongs
 * in multi_edit, where roclaude can keep undo copies, review the code and
 * protect Team Create collaborators.
 */
export const writesScripts = (code: string) => SCRIPT_WRITE.test(code)

const MUTATION =
  /[\w\])]\.[A-Za-z_]\w*\s*=(?!=)|:(Destroy|ClearAllChildren|Clone|SetAttribute|PivotTo|MoveTo|AddTag|RemoveTag|Remove|ScaleTo|SetPrimaryPartCFrame)\s*\(|Instance\.new\s*\(/

/** Whether Luau run in Studio likely changes the place (sets a property, adds or removes things). */
export const changesPlace = (code: string) => MUTATION.test(code)

/** Studio's mode from get_studio_state's answer: `Current Studio Mode: Edit`. */
export function studioMode(text: string): 'edit' | 'play' | null {
  const mode = /Current Studio Mode:\s*(\w+)/i.exec(text)?.[1]
  if (mode === undefined) return null
  return mode.toLowerCase() === 'edit' ? 'edit' : 'play'
}

/** Whether a tool's error says the place is in a playtest. */
export const saysPlaying = (text: string) => /not available in Play mode|in Play mode/i.test(text)

export type Danger = { id: string; reason: string }

const DANGERS: readonly (Danger & { pattern: RegExp })[] = [
  {
    id: 'destroy',
    pattern: /:(Destroy|ClearAllChildren)\s*\(|Debris:AddItem\s*\(/,
    reason: 'deletes instances from the place',
  },
  {
    id: 'datastore-write',
    pattern: /:(SetAsync|UpdateAsync|RemoveAsync|IncrementAsync)\s*\(/,
    reason: 'writes to DataStores, which can change real player data',
  },
  {
    id: 'players',
    pattern: /:(BanAsync|UnbanAsync|Kick)\s*\(/,
    reason: 'kicks or bans players',
  },
  {
    id: 'remote-code',
    pattern: /\brequire\s*\(\s*\d{5,}\s*\)|InsertService:LoadAsset/,
    reason: 'loads code or assets by id from outside the place',
  },
]

/** What a piece of Luau run in Studio would do that the person should approve first. */
export function dangersIn(code: string): Danger[] {
  return DANGERS.filter(danger => danger.pattern.test(code)).map(({ id, reason }) => ({ id, reason }))
}

/** Counts error lines in Studio's Output, as get_console_output returns it. */
export function countErrors(output: string): number {
  return output
    .split('\n')
    .filter(line => /^[\w.]+:\d+: /.test(line) || /^(Error|Script error)/i.test(line)).length
}

/** The studio name from list_roblox_studios' JSON answer. */
export function studioName(text: string): string | null {
  try {
    const info = JSON.parse(text) as { studios?: { name?: unknown }[] }
    const name = info.studios?.[0]?.name
    return typeof name === 'string' ? name.replace(/\s*\(placeId:.*\)$/, '') : null
  } catch {
    return null
  }
}

export const GREP_CAP = 50

// Third-party code a game embeds: admin kits and package folders.
const VENDOR =
  /Kohl'?s Admin|Adonis|HD ?Admin|Building Tools|(^|[\\/.])Cmdr([\\/.]|$)|(^|[\\/.])(Dev)?Packages([\\/.]|$)|_Index/i

/** Whether a script path (dot or file) lies inside third-party code. */
export const isVendor = (path: string) => VENDOR.test(path)

/** The scripts script_grep found, in order, from its `Path: X | Line: N | ...` lines. */
export function grepScripts(text: string): { scripts: string[]; matches: number } {
  const scripts: string[] = []
  let matches = 0
  for (const line of text.split('\n')) {
    const match = /^Path: (.+?) \| Line: \d+ \|/.exec(line)
    if (match === null) continue
    matches += 1
    const path = match[1] ?? ''
    if (!scripts.includes(path)) scripts.push(path)
  }
  return { scripts, matches }
}

/**
 * Who is in the Team Create session, from Studio's Output: `X joined live
 * editing session.` adds X and a line saying X left removes them.
 */
export function teamFrom(output: string, before: readonly string[]): string[] {
  const team = [...before]
  for (const line of output.split('\n')) {
    const joined = /^(\S+) joined (the )?live editing session/i.exec(line)
    const left = /^(\S+) (left|disconnected from|has left) (the )?live editing session/i.exec(line)
    const name = joined?.[1] ?? left?.[1]
    if (name === undefined) continue
    const at = team.indexOf(name)
    if (joined !== null && at === -1) team.push(name)
    if (left !== null && at !== -1) team.splice(at, 1)
  }
  return team
}

/** What Claude last read of a script: its lines from `start` (1-based), whole or a range. */
export type SeenText = { start: number; lines: readonly string[]; isWhole: boolean }

/** Whether a script still reads as Claude last saw it. */
export function stillAsSeen(seen: SeenText, source: string): boolean {
  const lines = source.split('\n')
  if (seen.isWhole && lines.length !== seen.lines.length) return false
  return seen.lines.every((line, i) => lines[seen.start - 1 + i] === line)
}

/** A script path as one key, with or without the leading `game.`. */
export const scriptKey = (path: string) => path.replace(/^game\./, '')

/** The first studio's id from list_roblox_studios' JSON answer. */
export function studioId(text: string): string | null {
  try {
    const info = JSON.parse(text) as { studios?: { id?: unknown }[] }
    const id = info.studios?.[0]?.id
    return typeof id === 'string' ? id : null
  } catch {
    return null
  }
}
