import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore } from '../src/store.js'
import { acceptCandidate, buildSourceEnvelope, createCalibrationCandidate, createEmptyModel, extractCandidates, parseImportedContent } from '../src/weavespec.js'

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

test('a calibration correction becomes a tentative candidate only in its project', () => {
  const root = mkdtempSync(join(tmpdir(), 'tacitweave-store-'))
  try {
    const alpha = new MemoryStore(root, { projectId: 'alpha' })
    const saved = alpha.savePolicy({
      agentId: 'agent', turn: 1,
      policy: { riskLevel: 'low' },
      outcome: { status: 'adjusted', correction: '低风险代码修改不用问我，直接处理。' },
    })
    assert.ok(saved.memoryCandidate)
    assert.match(alpha.renderContext(), /低风险代码修改不用问我/)
    const beta = new MemoryStore(root, { projectId: 'beta' })
    assert.doesNotMatch(beta.renderContext(), /低风险代码修改不用问我/)
    assert.equal(alpha.readModel().preferences.length, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('repeated evidence raises confidence and conflicts block tentative activation', () => {
  const root = mkdtempSync(join(tmpdir(), 'tacitweave-store-'))
  try {
    const store = new MemoryStore(root, { projectId: 'alpha' })
    const policy = { riskLevel: 'low' }
    const first = createCalibrationCandidate({ correction: '低风险代码修改不用问我。', policy, projectId: 'alpha', createdAt: '2026-01-01T00:00:00.000Z' })
    const second = createCalibrationCandidate({ correction: '低风险代码修改不用问我。', policy, projectId: 'alpha', createdAt: '2026-01-02T00:00:00.000Z' })
    const initial = store.saveCandidate(first)
    const merged = store.saveCandidate(second)
    assert.ok(merged.confidence > initial.confidence)
    const restrictive = createCalibrationCandidate({ correction: '涉及代码修改必须先问我确认。', policy, projectId: 'alpha', createdAt: '2026-01-03T00:00:00.000Z' })
    store.saveCandidate(restrictive)
    assert.equal(store.runtimeCandidates().length, 0)
    assert.ok(store.reviewSummary().conflicted >= 2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('selective review can defer and then accept a decision boundary', () => {
  const root = mkdtempSync(join(tmpdir(), 'tacitweave-store-'))
  try {
    const store = new MemoryStore(root, { projectId: 'alpha' })
    const candidate = createCalibrationCandidate({
      correction: '科研方法由我决定，不要替我选择。', policy: { riskLevel: 'medium' }, projectId: 'alpha', createdAt: '2026-01-01T00:00:00.000Z',
    })
    store.saveCandidate(candidate)
    store.applyReview(candidate.id, 'defer', { deferredUntil: '2999-01-01T00:00:00.000Z' })
    assert.equal(store.reviewQueue().length, 0)
    const found = store.findCandidate(candidate.id)
    found.candidate.review.deferred_until = null
    writeFileSync(found.path, `${JSON.stringify(found.batch, null, 2)}\n`, 'utf8')
    store.applyReview(candidate.id, 'accept')
    assert.equal(store.readModel().decision_boundaries.length, 1)
    assert.equal(store.readModel().preferences.length, 0)
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

test('dashboard controls filter memory without deleting source records', () => {
  const root = mkdtempSync(join(tmpdir(), 'tacitweave-store-'))
  try {
    const store = new MemoryStore(root, { projectId: 'alpha' })
    const parsed = parseImportedContent('I prefer concise explanations for routine code work.', 'markdown', 'notes.md')
    const source = buildSourceEnvelope({ messages: parsed.messages, format: parsed.format, inputPath: 'notes.md' })
    const candidate = extractCandidates(source).candidates[0]
    store.saveCandidate(candidate)
    const accepted = store.applyReview(candidate.id, 'accept')
    assert.equal(store.dashboardState().controls.show_floating_badge, true)
    assert.equal(store.dashboardState().long_term.length, 1)
    assert.equal(store.dashboardState().temporary.length, 0)

    store.setMemoryEnabled('long_term', accepted.memory_id, false)
    assert.doesNotMatch(store.renderContext(), /concise explanations/)
    assert.equal(store.readModel().preferences.length, 1)
    assert.equal(store.dashboardState().long_term[0].enabled, false)

    store.setMemoryEnabled('long_term', accepted.memory_id, true)
    store.updateControls({ activation_threshold: 1 })
    assert.doesNotMatch(store.renderContext(), /concise explanations/)
    store.updateControls({ activation_threshold: 0.5 })
    assert.match(store.renderContext(), /concise explanations/)
    store.updateControls({ enabled: false })
    assert.match(store.renderContext(), /disabled by the user/)
    store.updateControls({ show_floating_badge: false })
    assert.equal(store.dashboardState().controls.show_floating_badge, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('temporary memory toggles and review remain separate operations', () => {
  const root = mkdtempSync(join(tmpdir(), 'tacitweave-store-'))
  try {
    const store = new MemoryStore(root, { projectId: 'alpha' })
    const candidate = createCalibrationCandidate({
      correction: '低风险插件制作可以直接执行。', policy: { riskLevel: 'low' }, projectId: 'alpha',
    })
    store.saveCandidate(candidate)
    store.setMemoryEnabled('temporary', candidate.id, false)
    assert.equal(store.runtimeCandidates().length, 0)
    assert.equal(store.dashboardState().temporary[0].enabled, false)
    assert.equal(store.readModel().preferences.length, 0)
    store.applyReview(candidate.id, 'accept')
    assert.equal(store.dashboardState().temporary.length, 0)
    assert.equal(store.dashboardState().long_term.length, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
