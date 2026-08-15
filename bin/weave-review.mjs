#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  acceptCandidate,
  createEmptyModel,
  recordProvenance,
  rejectCandidate,
  restoreRecord,
  revokeRecord,
  sourceImpact,
  upgradeModel,
  validateWeaveModel,
} from '../src/weavespec.js'

const [command = 'list', ...rest] = process.argv.slice(2)
const args = parseArgs(rest)
const memoryDir = resolve(args['memory-dir'] ?? '.personal-model')
const modelPath = join(memoryDir, 'personal_model.json')

if (command === 'list') listCandidates(args.status ?? 'candidate')
else if (command === 'show') showCandidate(requiredId())
else if (command === 'accept') accept(requiredId())
else if (command === 'reject') reject(requiredId())
else if (command === 'defer') defer(requiredId())
else if (command === 'digest') digest()
else if (command === 'revoke') revoke(requiredId())
else if (command === 'restore') restore(requiredId())
else if (command === 'provenance') provenance(requiredId())
else if (command === 'source-impact') showSourceImpact(requiredSource())
else if (command === 'delete-source') deleteSource(requiredSource())
else if (command === 'migrate') migrate()
else if (command === 'validate') validate()
else fail('Commands: list, digest, show, accept, reject, defer, revoke, restore, provenance, source-impact, delete-source, migrate, validate')

function listCandidates(status) {
  const records = loadBatches()
    .flatMap(({ batch }) => batch.candidates ?? [])
    .filter(candidate => status === 'all' || candidate.status === status)
    .map(candidate => ({
      id: candidate.id,
      status: candidate.status,
      kind: candidate.kind,
      dimension: candidate.dimension,
      confidence: candidate.confidence,
      review_priority: candidate.review?.priority ?? 0,
      activation: candidate.activation ?? null,
      conflicts_with: candidate.conflicts_with ?? [],
      claim: candidate.claim,
    }))
  console.log(JSON.stringify({ count: records.length, candidates: records }, null, 2))
}

function digest() {
  const limit = Math.max(1, Math.min(20, Number(args.limit ?? 2)))
  const now = Date.now()
  const candidates = loadBatches().flatMap(({ batch }) => batch.candidates ?? [])
    .filter(item => item.status === 'candidate')
    .filter(item => !item.review?.deferred_until || Date.parse(item.review.deferred_until) <= now)
    .sort((a, b) => (b.review?.priority ?? 0) - (a.review?.priority ?? 0) || b.confidence - a.confidence)
    .slice(0, limit)
  console.log(JSON.stringify({ count: candidates.length, candidates }, null, 2))
}

function showCandidate(id) {
  const found = findCandidate(id)
  if (!found) fail(`Candidate not found: ${id}`)
  console.log(JSON.stringify(found.candidate, null, 2))
}

function accept(id) {
  const found = findCandidate(id)
  if (!found) fail(`Candidate not found: ${id}`)
  if (found.candidate.status !== 'candidate') fail(`Candidate is already ${found.candidate.status}: ${id}`)
  const currentModel = readModel()
  const model = acceptCandidate(currentModel, found.candidate, {
    claim: args.claim,
    domains: args.domain,
    actions: args.action,
    risk: args.risk,
    reversibility: args.reversibility,
    projects: args.project,
    exclusions: args.exclude,
    expiresAt: args.expires,
  })
  const records = [...model.preferences, ...model.decision_boundaries]
  const accepted = records.find(item => item.id === id.replace(/^candidate-/, 'pref-'))
    ?? records.find(item => item.claim === (args.claim ?? found.candidate.claim))
  found.candidate.status = 'user_confirmed'
  found.candidate.last_reviewed_at = new Date().toISOString()
  found.candidate.accepted_preference_id = accepted?.id ?? null
  writeJsonAtomic(found.path, found.batch)
  writeJsonAtomic(modelPath, model)
  console.log(JSON.stringify({ accepted_candidate: id, memory_id: accepted?.id ?? null, personal_model_file: modelPath }, null, 2))
}

function defer(id) {
  const found = findCandidate(id)
  if (!found) fail(`Candidate not found: ${id}`)
  if (found.candidate.status !== 'candidate') fail(`Candidate is already ${found.candidate.status}: ${id}`)
  const days = Math.max(1, Math.min(365, Number(args.days ?? 7)))
  const deferredUntil = new Date(Date.now() + days * 86400000).toISOString()
  found.candidate.review = { ...(found.candidate.review ?? {}), deferred_until: deferredUntil }
  writeJsonAtomic(found.path, found.batch)
  console.log(JSON.stringify({ deferred_candidate: id, deferred_until: deferredUntil }, null, 2))
}

function revoke(id) {
  const model = revokeRecord(readModel(), id, args.reason ?? 'revoked by user')
  writeJsonAtomic(modelPath, model)
  console.log(JSON.stringify({ revoked_memory: id, reason: args.reason ?? 'revoked by user' }, null, 2))
}

function restore(id) {
  const model = restoreRecord(readModel(), id)
  writeJsonAtomic(modelPath, model)
  console.log(JSON.stringify({ restored_memory: id }, null, 2))
}

function provenance(id) {
  const result = recordProvenance(readModel(), id)
  if (!result) fail(`Memory record not found: ${id}`)
  console.log(JSON.stringify(result, null, 2))
}

function showSourceImpact(sourceId) {
  const confirmed = sourceImpact(readModel(), sourceId)
  const candidates = loadBatches().flatMap(({ batch }) => batch.candidates ?? [])
    .filter(record => (record.evidence ?? []).some(item => item.source_id === sourceId))
    .map(record => ({ id: record.id, status: record.status, claim: record.claim }))
  console.log(JSON.stringify({ source_id: sourceId, confirmed_memory: confirmed, candidates }, null, 2))
}

function deleteSource(sourceId) {
  if (String(args['revoke-dependent']) !== 'true') {
    fail('delete-source requires --revoke-dependent true so cited confirmed memory is revoked before deletion')
  }
  let model = readModel()
  const impacted = sourceImpact(model, sourceId)
  for (const record of impacted.filter(item => item.status === 'user_confirmed')) {
    model = revokeRecord(model, record.id, `source deleted: ${sourceId}`)
  }
  writeJsonAtomic(modelPath, model)
  for (const item of loadBatches()) {
    let changed = false
    for (const candidate of item.batch.candidates ?? []) {
      if (!(candidate.evidence ?? []).some(evidence => evidence.source_id === sourceId)) continue
      candidate.status = candidate.status === 'candidate' ? 'rejected' : candidate.status
      candidate.last_reviewed_at = new Date().toISOString()
      changed = true
    }
    if (changed) writeJsonAtomic(item.path, item.batch)
  }
  const sourcePath = join(memoryDir, 'sources', `${sourceId}.json`)
  const sourceFileExisted = existsSync(sourcePath)
  if (sourceFileExisted) unlinkSync(sourcePath)
  console.log(JSON.stringify({ deleted_source: sourceId, source_file_existed: sourceFileExisted, revoked_memory: impacted.map(item => item.id) }, null, 2))
}

function reject(id) {
  const found = findCandidate(id)
  if (!found) fail(`Candidate not found: ${id}`)
  if (found.candidate.status !== 'candidate') fail(`Candidate is already ${found.candidate.status}: ${id}`)
  Object.assign(found.candidate, rejectCandidate(found.candidate))
  writeJsonAtomic(found.path, found.batch)
  console.log(JSON.stringify({ rejected_candidate: id, personal_model_changed: false }, null, 2))
}

function migrate() {
  const model = upgradeModel(readModel())
  writeJsonAtomic(modelPath, model)
  console.log(JSON.stringify({ migrated: true, schema_version: model.schema_version, personal_model_file: modelPath }, null, 2))
}

function validate() {
  const result = validateWeaveModel(readModel())
  console.log(JSON.stringify(result, null, 2))
  if (!result.valid) process.exitCode = 1
}

function loadBatches() {
  const dir = join(memoryDir, 'candidates')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter(name => name.endsWith('.json'))
    .sort()
    .map(name => {
      const path = join(dir, name)
      return { path, batch: JSON.parse(readFileSync(path, 'utf8')) }
    })
}

function findCandidate(id) {
  for (const item of loadBatches()) {
    const candidate = item.batch.candidates?.find(entry => entry.id === id)
    if (candidate) return { ...item, candidate }
  }
  return null
}

function readModel() {
  if (!existsSync(modelPath)) return createEmptyModel(args.subject ?? 'local-user')
  return JSON.parse(readFileSync(modelPath, 'utf8'))
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(temporary, path)
}

function requiredId() {
  if (!args.id) fail(`${command} requires --id <candidate-id>`)
  return String(args.id)
}

function requiredSource() {
  if (!args.source) fail(`${command} requires --source <source-id>`)
  const source = String(args.source)
  if (!/^[a-zA-Z0-9_-]{1,160}$/.test(source)) fail('source ID contains invalid path characters')
  return source
}

function fail(message) {
  console.error(message)
  process.exit(2)
}

function parseArgs(argv) {
  const parsed = {}
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i]
    if (!item.startsWith('--')) continue
    const key = item.slice(2)
    const value = argv[i + 1]
    if (parsed[key] == null) parsed[key] = value
    else if (Array.isArray(parsed[key])) parsed[key].push(value)
    else parsed[key] = [parsed[key], value]
    i += 1
  }
  return parsed
}
