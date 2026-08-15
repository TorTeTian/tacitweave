import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  acceptCandidate,
  buildSourceEnvelope,
  createEmptyModel,
  extractCandidates,
  parseImportedContent,
  redactSensitive,
  recordProvenance,
  restoreRecord,
  revokeRecord,
  sourceImpact,
  upgradeModel,
  validateWeaveModel,
  WEAVESPEC_VERSION,
} from '../src/weavespec.js'

test('ChatGPT export becomes redacted user evidence and candidates', () => {
  const text = JSON.stringify([{
    mapping: {
      a: { message: { id: 'u1', author: { role: 'user' }, create_time: 1, content: { parts: ['I prefer routine code edits without asking me. api_key=supersecretvalue'] } } },
      b: { message: { id: 'a1', author: { role: 'assistant' }, create_time: 2, content: { parts: ['Assistant text is not source evidence.'] } } },
    },
  }])
  const parsed = parseImportedContent(text, 'chatgpt', 'conversations.json')
  const source = buildSourceEnvelope({ messages: parsed.messages, format: parsed.format, inputPath: 'conversations.json' })
  const batch = extractCandidates(source)
  assert.equal(source.messages.length, 1)
  assert.match(source.messages[0].content, /\[REDACTED\]/)
  assert.equal(batch.candidates.length, 1)
  assert.equal(batch.candidates[0].dimension, 'autonomy')
  assert.ok(batch.candidates[0].exclusions.includes('production_changes'))
})

test('confirmed memory can be traced, revoked, and restored', () => {
  const parsed = parseImportedContent('I prefer concise explanations.', 'markdown', 'notes.md')
  const source = buildSourceEnvelope({ messages: parsed.messages, format: parsed.format, inputPath: 'notes.md' })
  const candidate = extractCandidates(source).candidates[0]
  const confirmed = acceptCandidate(createEmptyModel(), candidate)
  const id = confirmed.preferences[0].id
  assert.equal(recordProvenance(confirmed, id).evidence[0].source_id, source.source_id)
  assert.equal(sourceImpact(confirmed, source.source_id)[0].id, id)
  const revoked = revokeRecord(confirmed, id, 'outdated')
  assert.equal(revoked.preferences[0].status, 'revoked')
  assert.equal(restoreRecord(revoked, id).preferences[0].status, 'user_confirmed')
})

test('Markdown and JSONL imports preserve explicit user statements', () => {
  const markdown = parseImportedContent('我希望低风险代码修改不用问我。\n科研方法由我决定，不要替我选择。', 'markdown', 'notes.md')
  const markdownBatch = extractCandidates(buildSourceEnvelope({ messages: markdown.messages, format: markdown.format, inputPath: 'notes.md' }))
  assert.equal(markdownBatch.candidates.length, 2)
  assert.deepEqual(markdownBatch.candidates.map(item => item.dimension).sort(), ['autonomy', 'decision_ownership'])

  const jsonl = parseImportedContent('{"role":"user","content":"Ask me before publishing anything."}\n{"role":"assistant","content":"OK"}', 'jsonl', 'messages.jsonl')
  const jsonlBatch = extractCandidates(buildSourceEnvelope({ messages: jsonl.messages, format: jsonl.format, inputPath: 'messages.jsonl' }))
  assert.equal(jsonlBatch.candidates.length, 1)
  assert.equal(jsonlBatch.candidates[0].kind, 'decision_boundary')
})

test('duplicate statements merge evidence before review', () => {
  const parsed = parseImportedContent('I prefer concise explanations.\nI prefer concise explanations.', 'markdown', 'notes.md')
  const batch = extractCandidates(buildSourceEnvelope({ messages: parsed.messages, format: parsed.format, inputPath: 'notes.md' }))
  assert.equal(batch.candidates.length, 1)
  assert.equal(batch.candidates[0].evidence.length, 2)
})

test('opposing autonomy statements are flagged instead of auto-resolved', () => {
  const parsed = parseImportedContent('低风险代码修改不要问我。\n涉及代码修改必须先问我确认。', 'markdown', 'notes.md')
  const batch = extractCandidates(buildSourceEnvelope({ messages: parsed.messages, format: parsed.format, inputPath: 'notes.md' }))
  assert.equal(batch.candidates.length, 2)
  assert.deepEqual(batch.candidates[0].conflicts_with, [batch.candidates[1].id])
  assert.deepEqual(batch.candidates[1].conflicts_with, [batch.candidates[0].id])
})

test('accepting a candidate creates a confirmed WeaveSpec model', () => {
  const parsed = parseImportedContent('For routine code edits, I prefer that you choose details without asking me.', 'markdown', 'notes.md')
  const candidate = extractCandidates(buildSourceEnvelope({ messages: parsed.messages, format: parsed.format, inputPath: 'notes.md' })).candidates[0]
  const model = acceptCandidate(createEmptyModel(), candidate, { domains: 'software_engineering', risk: 'low', reversibility: 'reversible' }, '2026-01-01T00:00:00.000Z')
  assert.equal(model.schema_version, WEAVESPEC_VERSION)
  assert.equal(model.preferences.length, 1)
  assert.equal(model.preferences[0].status, 'user_confirmed')
  assert.deepEqual(model.preferences[0].scope.risk, ['low'])
  assert.equal(validateWeaveModel(model).valid, true)
})

test('legacy personal models upgrade without losing their claims', () => {
  const upgraded = upgradeModel({
    schema_version: 1,
    user_label: 'example-user',
    preferences: [{ id: 'old', claim: '旧偏好', dimension: 'autonomy', scope: ['software_engineering'], exceptions: ['production'], confidence: 1, evidence: ['direct statement'] }],
    safety_invariants: ['confirm risky work'],
  })
  assert.equal(upgraded.schema_version, WEAVESPEC_VERSION)
  assert.equal(upgraded.subject.id, 'example-user')
  assert.equal(upgraded.preferences[0].claim, '旧偏好')
  assert.equal(upgraded.preferences[0].status, 'user_confirmed')
})

test('review CLI keeps candidates separate until explicit acceptance', () => {
  const root = mkdtempSync(join(tmpdir(), 'tacitweave-test-'))
  try {
    const input = join(root, 'notes.md')
    const memory = join(root, 'memory')
    writeFileSync(input, 'I prefer concise explanations for routine code tasks.\n', 'utf8')
    const ingest = spawnSync(process.execPath, [resolve('bin/weave-ingest.mjs'), '--input', input, '--memory-dir', memory], { encoding: 'utf8' })
    assert.equal(ingest.status, 0, ingest.stderr)
    const summary = JSON.parse(ingest.stdout)
    assert.equal(summary.personal_model_changed, false)
    const repeated = spawnSync(process.execPath, [resolve('bin/weave-ingest.mjs'), '--input', input, '--memory-dir', memory], { encoding: 'utf8' })
    assert.equal(JSON.parse(repeated.stdout).already_imported, true)
    const list = spawnSync(process.execPath, [resolve('bin/weave-review.mjs'), 'list', '--memory-dir', memory], { encoding: 'utf8' })
    const candidate = JSON.parse(list.stdout).candidates[0]
    const accept = spawnSync(process.execPath, [resolve('bin/weave-review.mjs'), 'accept', '--id', candidate.id, '--memory-dir', memory, '--domain', 'software_engineering'], { encoding: 'utf8' })
    assert.equal(accept.status, 0, accept.stderr)
    const model = JSON.parse(readFileSync(join(memory, 'personal_model.json'), 'utf8'))
    assert.equal(model.preferences[0].status, 'user_confirmed')
    const unsafeSource = spawnSync(process.execPath, [resolve('bin/weave-review.mjs'), 'source-impact', '--source', '../personal_model', '--memory-dir', memory], { encoding: 'utf8' })
    assert.equal(unsafeSource.status, 2)
    assert.match(unsafeSource.stderr, /invalid path characters/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('redaction removes common credentials without pretending to anonymize prose', () => {
  assert.equal(redactSensitive('password=hunterhunter'), 'password=[REDACTED]')
  assert.match(redactSensitive('hello@example.com'), /hello@example\.com/)
})

test('published schema and example model match the runtime contract', () => {
  const schema = JSON.parse(readFileSync(resolve('schemas/weavespec-v0.2.schema.json'), 'utf8'))
  const example = JSON.parse(readFileSync(resolve('examples/memory/personal_model.example.json'), 'utf8'))
  assert.equal(schema.properties.schema_version.const, WEAVESPEC_VERSION)
  assert.equal(validateWeaveModel(example).valid, true)
  assert.match(example.preferences[0].evidence[0].excerpt_sha256, /^[a-f0-9]{64}$/)
})
