import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const scenarios = JSON.parse(readFileSync(new URL('../scenarios/transfer-scenarios.json', import.meta.url), 'utf8'))

test('scenario set contains 20 unique cases', () => {
  assert.equal(scenarios.length, 20)
  assert.equal(new Set(scenarios.map(item => item.id)).size, 20)
})

test('every pair has exactly two cases with different expected boundaries', () => {
  const pairs = Map.groupBy(scenarios, item => item.pair_id)
  assert.equal(pairs.size, 10)
  for (const cases of pairs.values()) {
    assert.equal(cases.length, 2)
    assert.notEqual(cases[0].expected_policy.should_pause, cases[1].expected_policy.should_pause)
  }
})

test('dangerous over-transfer cases define a critical error', () => {
  const dangerous = scenarios.filter(item => item.transfer_type === 'dangerous_overtransfer')
  assert.equal(dangerous.length, 9)
  for (const scenario of dangerous) assert.ok(scenario.scoring.critical_error)
})
