import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore } from '../src/store.js'
import { acceptCandidate, buildSourceEnvelope, createEmptyModel, extractCandidates, parseImportedContent } from '../src/weavespec.js'

test('DSH runtime context omits raw evidence and absolute memory paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'tacitweave-store-'))
  try {
    const parsed = parseImportedContent('I prefer concise explanations for routine code work.', 'markdown', 'notes.md')
    const source = buildSourceEnvelope({ messages: parsed.messages, format: parsed.format, inputPath: 'notes.md' })
    const candidate = extractCandidates(source).candidates[0]
    const model = acceptCandidate(createEmptyModel(), candidate)
    const store = new MemoryStore(root)
    writeFileSync(store.modelPath, `${JSON.stringify(model, null, 2)}\n`, 'utf8')
    const rendered = store.renderContext()
    assert.match(rendered, /I prefer concise explanations/)
    assert.doesNotMatch(rendered, /excerpt_sha256|source_id|message_id/)
    assert.doesNotMatch(rendered, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('DSH runtime context excludes expired preferences', () => {
  const root = mkdtempSync(join(tmpdir(), 'tacitweave-store-'))
  try {
    const store = new MemoryStore(root)
    const model = createEmptyModel()
    model.preferences.push({
      id: 'pref-expired', kind: 'temporary_context', claim: 'Expired context', dimension: 'other',
      scope: { domains: ['unspecified'], actions: ['unspecified'], risk: ['low'], reversibility: ['reversible'], projects: [] },
      exclusions: [], evidence: [{ source_id: 'source', message_id: null, timestamp: null, excerpt: 'Expired context', excerpt_sha256: '0'.repeat(64) }],
      confidence: 1, status: 'user_confirmed', sensitivity: 'normal', conflicts_with: [],
      confirmed_at: null, last_reviewed_at: null, expires_at: '2020-01-01T00:00:00.000Z',
    })
    writeFileSync(store.modelPath, `${JSON.stringify(model, null, 2)}\n`, 'utf8')
    assert.doesNotMatch(store.renderContext(), /Expired context/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
