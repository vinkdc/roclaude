// Line diffs of a script before and after an edit, for the replay theater.

export type LineDiff = {
  added: number
  removed: number
  /** A unified diff with @@ hunk headers, as a `Code` element draws it under `format: 'diff'`. */
  unified: string
}

const CONTEXT = 2
const MAX_CELLS = 4_000_000

type Op = { kind: ' ' | '-' | '+'; line: string; oldNo: number; newNo: number }

// The edit script between two line lists: a longest common subsequence on
// what differs once the shared head and tail are set aside.
function operations(a: readonly string[], b: readonly string[]): Op[] {
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1

  const midA = a.slice(head, a.length - tail)
  const midB = b.slice(head, b.length - tail)
  const ops: Op[] = []
  for (let i = 0; i < head; i += 1) ops.push({ kind: ' ', line: a[i] ?? '', oldNo: i + 1, newNo: i + 1 })

  if (midA.length * midB.length > MAX_CELLS) {
    // Too large to align: the middle reads as replaced.
    midA.forEach((line, i) => ops.push({ kind: '-', line, oldNo: head + i + 1, newNo: head + 1 }))
    midB.forEach((line, i) => ops.push({ kind: '+', line, oldNo: head + midA.length + 1, newNo: head + i + 1 }))
  } else {
    const n = midA.length
    const m = midB.length
    const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        table[i]![j] = midA[i] === midB[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!)
      }
    }
    let i = 0
    let j = 0
    while (i < n || j < m) {
      if (i < n && j < m && midA[i] === midB[j]) {
        ops.push({ kind: ' ', line: midA[i]!, oldNo: head + i + 1, newNo: head + j + 1 })
        i += 1
        j += 1
      } else if (j < m && (i === n || table[i]![j + 1]! > table[i + 1]![j]!)) {
        // On a tie the removal goes first, as diffs read.
        ops.push({ kind: '+', line: midB[j]!, oldNo: head + i + 1, newNo: head + j + 1 })
        j += 1
      } else {
        ops.push({ kind: '-', line: midA[i]!, oldNo: head + i + 1, newNo: head + j + 1 })
        i += 1
      }
    }
  }

  for (let k = 0; k < tail; k += 1) {
    const oldNo = a.length - tail + k + 1
    const newNo = b.length - tail + k + 1
    ops.push({ kind: ' ', line: a[oldNo - 1] ?? '', oldNo, newNo })
  }
  return ops
}

/** The diff of a script from `before` (null: it did not exist) to `after`. */
export function lineDiff(before: string | null, after: string): LineDiff {
  const a = before === null || before === '' ? [] : before.split('\n')
  const b = after === '' ? [] : after.split('\n')
  const ops = operations(a, b)
  const added = ops.filter(op => op.kind === '+').length
  const removed = ops.filter(op => op.kind === '-').length

  // Hunks: each change with CONTEXT unchanged lines around it, merged when close.
  const changed = ops.map((op, i) => (op.kind === ' ' ? -1 : i)).filter(i => i !== -1)
  const hunks: [number, number][] = []
  for (const i of changed) {
    const from = Math.max(0, i - CONTEXT)
    const to = Math.min(ops.length - 1, i + CONTEXT)
    const last = hunks[hunks.length - 1]
    if (last !== undefined && from <= last[1] + 1) last[1] = Math.max(last[1], to)
    else hunks.push([from, to])
  }

  const lines: string[] = []
  for (const [from, to] of hunks) {
    const part = ops.slice(from, to + 1)
    const oldCount = part.filter(op => op.kind !== '+').length
    const newCount = part.filter(op => op.kind !== '-').length
    const first = part[0]!
    const oldStart = oldCount === 0 ? first.oldNo - 1 : first.oldNo
    const newStart = newCount === 0 ? first.newNo - 1 : first.newNo
    lines.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`)
    for (const op of part) lines.push(`${op.kind}${op.line}`)
  }
  return { added, removed, unified: lines.join('\n') }
}

/**
 * The first sentence of Claude's reply that says something, short enough for
 * a card: a bare "Done." or "All set!" is passed over.
 */
export function firstSentence(text: string, max = 160): string {
  const plain = text.replace(/[`*_#>]/g, '').replace(/\s+/g, ' ').trim()
  // A sentence ends at . ! or ? followed by a space, so Workspace.House.Door stays whole.
  const sentences = plain.split(/(?<=[.!?])\s+/)
  const sentence = (sentences.find(one => one.trim().split(' ').length >= 4) ?? sentences[0] ?? plain).trim()
  return sentence.length > max ? `${sentence.slice(0, max - 1)}…` : sentence
}
