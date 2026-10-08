export type LintIssue = { line: number; rule: string; message: string }
export type LintReport = { file: string; issues: readonly LintIssue[] }

/**
 * A script as it was before Claude's multi_edit (`source`, null when the edit
 * created it) and right after (`after`, null when it could not be read).
 */
export type Snapshot = {
  id: number
  server: string
  studioId: string
  path: string
  source: string | null
  after: string | null
  /** The turn the edit was made in, for replaying one turn. */
  turn: number
}

/**
 * The Studio MCP server last used and the place's state: its mode, how many
 * changes Claude made since the last playtest, and that playtest's errors.
 */
export type StudioInfo = {
  name: string | null
  server: string | null
  id: string | null
  errors: number | null
  mode: 'edit' | 'play' | null
  untested: number
}

export type RemoteStatus = 'unchecked' | 'gated' | 'checked' | 'no-args'
export type RemoteHandler = {
  line: number
  remote: string
  kind: 'event' | 'function'
  status: RemoteStatus
  unchecked: readonly string[]
}
export type RemoteReport = {
  scripts: number
  /** `isVendor`: inside a third-party module (an admin kit, a package), reported apart. */
  handlers: readonly (RemoteHandler & { script: string; isVendor: boolean })[]
  note: string | null
}

export type TouchAction = 'read' | 'edited' | 'created' | 'changed'
/** An object's properties as Studio's inspect_instance reports them. */
export type PropMap = Readonly<Record<string, string | number | boolean>>
/** Something in the place Claude read or changed this session. */
export type TouchedItem = {
  path: string
  kind: 'script' | 'instance'
  action: TouchAction
  /** A call on it is in flight, and as what. */
  isActive: boolean
  activeAs: 'reading' | 'editing' | 'changing' | null
  seq: number
  /**
   * An object's properties before Claude first changed it this session (null:
   * it did not exist) and after its latest change (null: it was deleted);
   * absent when they were not captured.
   */
  propsBefore?: PropMap | null
  propsAfter?: PropMap | null
}

declare module 'claude-code' {
  interface PluginState {
    'roclaude': {
      lastLint: LintReport | null
      isHidden: boolean
      studio: StudioInfo | null
      history: readonly Snapshot[]
      remotes: RemoteReport | null
      /** Who Studio's Output says is in the Team Create session. */
      team: readonly string[]
      /** Edits refused because the script changed after Claude read it. */
      staleBlocks: number
      /** What Claude read and changed this session, for the activity pane. */
      touched: readonly TouchedItem[]
      /** Whether Claude's turn is running. */
      isWorking: boolean
      /** Counts the person's prompts, so edits can be grouped by turn. */
      turn: number
      /** The touched item whose change the activity view shows. */
      selected: string | null
      /** Counts activity cards drawn in the chat; only the newest is live. */
      cardRun: number
    }
  }
}
