import test from 'node:test'
import assert from 'node:assert/strict'
import { isAbsolute } from 'node:path'
import { resolveMemoryDirectory } from '../src/paths.js'

test('relative memory directories expose their working-directory dependency', () => {
  const result = resolveMemoryDirectory('.personal-model', { cwd: process.cwd(), environment: {} })
  assert.equal(result.relative, true)
  assert.equal(result.source, 'configuration')
  assert.equal(isAbsolute(result.path), true)
})

test('TACITWEAVE_MEMORY_DIR gives the plugin and CLI one absolute location', () => {
  const absolute = process.platform === 'win32' ? 'D:\\private\\tacitweave' : '/private/tacitweave'
  const result = resolveMemoryDirectory('.personal-model', {
    cwd: process.cwd(), environment: { TACITWEAVE_MEMORY_DIR: absolute },
  })
  assert.equal(result.path, absolute)
  assert.equal(result.relative, false)
  assert.equal(result.source, 'TACITWEAVE_MEMORY_DIR')
})
