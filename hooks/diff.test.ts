import { expect, test } from 'claude-code/testing'

import { firstSentence, lineDiff } from './diff'

test('a one-line change is one hunk with context', () => {
  const before = ['local a = 1', 'local b = 2', 'print(greet(who))', 'local c = 3', 'return a'].join('\n')
  const after = ['local a = 1', 'local b = 2', 'print(welcome(who))', 'local c = 3', 'return a'].join('\n')
  const diff = lineDiff(before, after)
  expect(diff.added).toBe(1)
  expect(diff.removed).toBe(1)
  expect(diff.unified).toBe(
    ['@@ -1,5 +1,5 @@', ' local a = 1', ' local b = 2', '-print(greet(who))', '+print(welcome(who))', ' local c = 3', ' return a'].join('\n'),
  )
})

test('distant changes make separate hunks', () => {
  const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`)
  const after = [...lines]
  after[1] = 'changed 2'
  after[17] = 'changed 18'
  const diff = lineDiff(lines.join('\n'), after.join('\n'))
  expect(diff.unified.match(/^@@/gm)?.length).toBe(2)
  expect(diff.added).toBe(2)
})

test('a created script is all added lines', () => {
  const diff = lineDiff(null, 'local M = {}\nreturn M')
  expect(diff).toEqual({ added: 2, removed: 0, unified: '@@ -0,0 +1,2 @@\n+local M = {}\n+return M' })
})

test('an unchanged script has no hunks', () => {
  expect(lineDiff('a\nb', 'a\nb').unified).toBe('')
})

test('keeps the first sentence that says something, without markdown', () => {
  expect(firstSentence('Done. Opening the door now flings the player who triggered it. Closing does not.')).toBe(
    'Opening the door now flings the player who triggered it.',
  )
  expect(firstSentence('I renamed `greet` to **welcome** in all 4 files. Then I tested it.')).toBe(
    'I renamed greet to welcome in all 4 files.',
  )
})
