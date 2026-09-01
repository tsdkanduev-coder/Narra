import assert from 'node:assert/strict'
import test from 'node:test'
import { formatCharacterDisplayName } from '../character-display-name.mjs'

test('character display names capitalize every lowercase word start', () => {
  assert.equal(formatCharacterDisplayName('анна каренина'), 'Анна Каренина')
  assert.equal(
    formatCharacterDisplayName('родион романович раскольников'),
    'Родион Романович Раскольников'
  )
  assert.equal(formatCharacterDisplayName('жан-вальжан'), 'Жан-Вальжан')
  assert.equal(formatCharacterDisplayName("o'connor"), "O'Connor")
  assert.equal(formatCharacterDisplayName('а. с. пушкин'), 'А. С. Пушкин')
})

test('character display names normalize spacing without destroying existing casing', () => {
  assert.equal(formatCharacterDisplayName('  mcDonald\tиВАНОВ  '), 'McDonald ИВАНОВ')
  assert.equal(formatCharacterDisplayName('МАРИЯ'), 'МАРИЯ')
  assert.equal(formatCharacterDisplayName(null), '')
})

test('pseudo-characters named after the narrative voice are recognised', async () => {
  const { isPseudoCharacterName } = await import('../character-display-name.mjs')
  assert.equal(isPseudoCharacterName('Рассказчик'), true)
  assert.equal(isPseudoCharacterName('  автор '), true)
  assert.equal(isPseudoCharacterName('Narrator', 'Narrator'), true)
  assert.equal(isPseudoCharacterName('Рассказчик', 'Иван Петрович Белкин'), false)
  assert.equal(isPseudoCharacterName('Раскольников'), false)
  assert.equal(isPseudoCharacterName(''), false)
})
