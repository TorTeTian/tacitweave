#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  acceptCandidate,
  createEmptyModel,
  rejectCandidate,
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
else if (command === 'migrate') migrate()
else if (command === 'validate') validate()
else fail('Commands: list, show --id ID, accept --id ID, reject --id ID, migrate, validate')

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
      conflicts_with: candidate.conflicts_with ?? [],
      claim: candidate.claim,
    }))
  console.log(JSON.stringify({ count: records.length, candidates: records }, null, 2))
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
  const accepted = model.preferences.find(item => item.id === id.replace(/^candidate-/, 'pref-'))
    ?? model.preferences.find(item => item.claim === (args.claim ?? found.candidate.claim))
  found.candidate.status = 'user_confirmed'
  found.candidate.last_reviewed_at = new Date().toISOString()
  found.candidate.accepted_preference_id = accepted?.id ?? null
  writeJsonAtomic(found.path, found.batch)
  writeJsonAtomic(modelPath, model)
  console.log(JSON.stringify({ accepted_candidate: id, preference_id: accepted?.id ?? null, personal_model_file: modelPath }, null, 2))
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
