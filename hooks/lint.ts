import type { LintIssue, RemoteHandler } from '../types'

type Rule = {
  id: string
  pattern: RegExp
  message: string
  // Match against the line with string literals kept (default: blanked).
  keepsStrings?: boolean
  unless?: RegExp
  when?: (path: string) => boolean
}

const SERVICES = [
  'Players',
  'ReplicatedStorage',
  'ServerStorage',
  'ServerScriptService',
  'RunService',
  'UserInputService',
  'TweenService',
  'DataStoreService',
  'HttpService',
  'MarketplaceService',
  'CollectionService',
  'SoundService',
  'StarterGui',
  'Debris',
]

// A script that runs on the server: under ServerScriptService or
// ServerStorage, or named `*.server.luau` (how a new Script is passed in).
export const isServerScript = (path: string) =>
  /\.server\.luau?$/i.test(path) || /(^|\.)(ServerScriptService|ServerStorage)\./.test(path)

export const RULES: readonly Rule[] = [
  {
    id: 'task-wait',
    pattern: /(^|[^.:\w])wait\s*\(/,
    unless: /function\s+wait\b/,
    message: 'wait() is deprecated and throttled; use task.wait().',
  },
  {
    id: 'task-spawn',
    pattern: /(^|[^.:\w])spawn\s*\(/,
    unless: /function\s+spawn\b/,
    message: 'spawn() is deprecated; use task.spawn() or task.defer().',
  },
  {
    id: 'task-delay',
    pattern: /(^|[^.:\w])delay\s*\(/,
    unless: /function\s+delay\b/,
    message: 'delay() is deprecated; use task.delay().',
  },
  {
    id: 'instance-parent-arg',
    pattern: /Instance\.new\s*\(\s*(["'])[^"']*\1\s*,/,
    keepsStrings: true,
    message: "Instance.new's parent argument is slow; set properties first and .Parent last.",
  },
  {
    id: 'get-service',
    pattern: new RegExp(`\\bgame\\.(${SERVICES.join('|')})\\b`),
    message: 'Get services with game:GetService("Name") instead of game.Name.',
  },
  {
    id: 'lowercase-method',
    pattern: /:(connect|disconnect|wait|findFirstChild|getChildren|remove|clone|destroy|isA)\s*\(/,
    message: 'Lowercase Roblox methods are deprecated; use the PascalCase name (:Connect, :FindFirstChild, :Destroy, ...).',
  },
  {
    id: 'server-localplayer',
    pattern: /\bLocalPlayer\b/,
    when: isServerScript,
    message: 'Players.LocalPlayer is nil on the server; take the player from the event or Players:GetPlayers().',
  },
]

const MAX_ISSUES = 30

// Splits one line into code with strings kept and code with strings blanked,
// dropping comments. `inBlock` carries a --[[ block comment across lines.
function scanLine(line: string, inBlock: boolean) {
  let code = ''
  let bare = ''
  let i = 0

  if (inBlock) {
    const end = line.indexOf(']]')
    if (end === -1) return { code, bare, inBlock: true }
    i = end + 2
  }

  while (i < line.length) {
    const ch = line[i]
    if (ch === '"' || ch === "'") {
      let j = i + 1
      while (j < line.length && line[j] !== ch) j += line[j] === '\\' ? 2 : 1
      code += line.slice(i, j + 1)
      bare += ch + ch
      i = j + 1
      continue
    }
    if (ch === '-' && line[i + 1] === '-') {
      if (/^--\[=*\[/.test(line.slice(i))) {
        const end = line.indexOf(']]', i)
        if (end === -1) return { code, bare, inBlock: true }
        i = end + 2
        continue
      }
      break
    }
    code += ch
    bare += ch
    i += 1
  }

  return { code, bare, inBlock: false }
}

/**
 * Checks Luau source for deprecated or risky Roblox patterns. `firstLine` is
 * the 1-based line the source starts at in its file (for a snippet).
 */
export function lintLuau(path: string, source: string, firstLine = 1): LintIssue[] {
  const issues: LintIssue[] = []
  const rules = RULES.filter(rule => rule.when === undefined || rule.when(path))
  let inBlock = false

  source.split(/\r?\n/).forEach((line, index) => {
    const scanned = scanLine(line, inBlock)
    inBlock = scanned.inBlock

    for (const rule of rules) {
      const text = rule.keepsStrings ? scanned.code : scanned.bare
      if (rule.pattern.test(text) && !rule.unless?.test(text)) {
        issues.push({ line: firstLine + index, rule: rule.id, message: rule.message })
      }
    }
  })

  return issues.slice(0, MAX_ISSUES)
}

const HANDLER =
  /(OnServerEvent:Connect\s*\(\s*function|OnServerInvoke\s*=\s*function)\s*\(([^)]*)\)/
const HANDLER_LINES = 200
const GATE_LINES = 6
const GATE =
  /\bif\s+not\s+\w*(admin|owner|allowed|whitelist|permi|authori[sz]|staff|mod)\w*\s*\(\s*\w+|\.UserId\s*[~=]=|:GetRankInGroup\s*\(|:IsInGroup\s*\(/i

// Ways a server handler checks a value it got from the client.
const checks = (name: string) => {
  const n = name === '...' ? '\\.\\.\\.' : name
  return new RegExp(
    [
      `typeof\\s*\\(\\s*${n}\\b`,
      `\\btype\\s*\\(\\s*${n}\\b`,
      `tonumber\\s*\\(\\s*${n}\\b`,
      `assert\\s*\\([^)]*\\b${n}\\b`,
      `\\bif\\s+not\\s+${n}\\b`,
      `\\b${n}\\s*[~=]=`,
      `[=~]=\\s*${n}\\b`,
      `table\\.find\\s*\\([^)]*\\b${n}\\b`,
      `\\[\\s*${n}\\s*\\]`,
      `math\\.clamp\\s*\\(\\s*${n}\\b`,
      `select\\s*\\(\\s*["']#["']`,
    ].join('|'),
  )
}

// The lines of the function that opens on lines[start], found by counting
// Luau blocks (function/do/then/repeat against end/until) outside strings and
// comments; at most HANDLER_LINES lines.
function handlerBody(lines: readonly string[], start: number): string[] {
  let depth = 0
  let inBlock = false
  const body: string[] = []
  for (let i = start; i < lines.length && body.length < HANDLER_LINES; i += 1) {
    const scanned = scanLine(lines[i] ?? '', inBlock)
    inBlock = scanned.inBlock
    for (const word of scanned.bare.match(/\b(function|do|then|repeat|elseif|end|until)\b/g) ?? []) {
      depth += word === 'end' || word === 'until' || word === 'elseif' ? -1 : 1
    }
    if (i > start) body.push(lines[i] ?? '')
    if (depth <= 0) break
  }
  return body
}

/**
 * Every RemoteEvent and RemoteFunction server handler in a script, and how it
 * treats what the client sends: `unchecked` uses values without checking
 * them, `gated` first limits who may call it (admins, the owner), `checked`
 * checks every value, `no-args` takes nothing from the client. Luau type
 * annotations are not checks: an exploiter can send any value whatever the
 * annotation says.
 */
export function scanRemotes(source: string, firstLine = 1): RemoteHandler[] {
  const lines = source.split(/\r?\n/)
  const handlers: RemoteHandler[] = []

  lines.forEach((line, index) => {
    const match = HANDLER.exec(line)
    if (match === null) return

    const params = (match[2] ?? '')
      .split(',')
      .map(param => (param.split(':')[0] ?? '').trim())
      .filter(param => param.length > 0)
      .slice(1)
    const remote = /(\w+)\s*\.\s*OnServer(?:Event|Invoke)/.exec(line)?.[1] ?? '?'
    const kind = /OnServerInvoke/.test(match[1] ?? '') ? 'function' : 'event'
    const bodyLines = handlerBody(lines, index)
    const body = bodyLines.join('\n')
    const opening = bodyLines.slice(0, GATE_LINES).join('\n')
    const unchecked = params.filter(param => !checks(param).test(body))
    const status =
      params.length === 0 ? 'no-args' : GATE.test(opening) ? 'gated' : unchecked.length > 0 ? 'unchecked' : 'checked'

    handlers.push({
      line: firstLine + index,
      remote,
      kind,
      status,
      unchecked: status === 'unchecked' ? unchecked : [],
    })
  })

  return handlers
}

/** The unchecked handlers of `scanRemotes`, as findings for Claude. */
export function auditRemotes(source: string, firstLine = 1): LintIssue[] {
  return scanRemotes(source, firstLine)
    .filter(handler => handler.status === 'unchecked')
    .map(handler => ({
      line: handler.line,
      rule: 'remote-unchecked',
      message: `This server handler uses ${handler.unchecked.join(', ')} from the client without checking it. Exploiters can send any value (type annotations are not enforced): check typeof, ranges, cooldowns and ownership before use.`,
    }))
}

export function formatIssues(file: string, issues: readonly LintIssue[]): string {
  const lines = issues.map(issue => `  L${issue.line} ${issue.rule}: ${issue.message}`)
  return [
    `roclaude found ${issues.length} Roblox/Luau issue(s) in ${file}:`,
    ...lines,
    'Fix these in the code you just wrote unless the legacy behavior is intended.',
  ].join('\n')
}
