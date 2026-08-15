import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { sanitizeId } from './core.js'
import { createEmptyModel, upgradeModel } from './weavespec.js'

export class MemoryStore {
  constructor(memoryDir) {
    this.root = resolve(memoryDir)
    this.modelPath = join(this.root, 'personal_model.json')
    this.notesPath = join(this.root, 'current_context.md')
    this.feedbackPath = join(this.root, 'feedback.jsonl')
    this.policiesDir = join(this.root, 'policies')
    this.sourcesDir = join(this.root, 'sources')
    this.candidatesDir = join(this.root, 'candidates')
    this.ensureInitialized()
  }

  ensureInitialized() {
    mkdirSync(this.root, { recursive: true })
    mkdirSync(this.policiesDir, { recursive: true })
    mkdirSync(this.sourcesDir, { recursive: true })
    mkdirSync(this.candidatesDir, { recursive: true })
    if (!existsSync(this.modelPath)) writeJson(this.modelPath, createEmptyModel())
    if (!existsSync(this.notesPath)) {
      writeFileSync(this.notesPath, '# Current context\n\nAdd project- or user-confirmed context here.\n', 'utf8')
    }
  }

  readModel() {
    try {
      return upgradeModel(JSON.parse(readFileSync(this.modelPath, 'utf8')))
    } catch (error) {
      return { ...createEmptyModel(), load_error: String(error) }
    }
  }

  renderContext(maxChars = 12000) {
    const model = JSON.stringify(toRuntimeModel(this.readModel()), null, 2)
    let notes = ''
    try { notes = readFileSync(this.notesPath, 'utf8') } catch {}
    const text = [
      '## Explicit Personal Model (user-reviewable local files)',
      'This file follows WeaveSpec. Use only user_confirmed preferences. Candidate and rejected records never authorize behavior. Apply every preference only within its scope and exclusions. Safety invariants override autonomy preferences.',
      '### personal_model.json',
      model,
      '### current_context.md',
      notes,
    ].join('\n\n')
    return text.slice(0, maxChars)
  }

  inspect() {
    return {
      memory_dir: this.root,
      personal_model_file: this.modelPath,
      current_context_file: this.notesPath,
      feedback_file: this.feedbackPath,
      policies_dir: this.policiesDir,
      sources_dir: this.sourcesDir,
      candidates_dir: this.candidatesDir,
      pending_candidates: countPendingCandidates(this.candidatesDir),
      personal_model: this.readModel(),
    }
  }

  savePolicy({ agentId, turn, policy, outcome }) {
    const safeAgent = sanitizeId(agentId)
    const dir = join(this.policiesDir, safeAgent)
    mkdirSync(dir, { recursive: true })
    const record = {
      schema_version: 1,
      timestamp: new Date().toISOString(),
      agent_id: String(agentId),
      turn,
      policy,
      calibration: outcome,
    }
    const path = join(dir, `turn-${Number.isInteger(turn) ? turn : 'unknown'}.json`)
    writeJson(path, record)
    appendJsonLine(this.feedbackPath, record)
    return path
  }
}

function toRuntimeModel(model) {
  const now = Date.now()
  return {
    schema_version: model.schema_version,
    subject: { id: model.subject?.id ?? 'local-user' },
    updated_at: model.updated_at,
    preferences: (model.preferences ?? [])
      .filter(preference => preference.status === 'user_confirmed')
      .filter(preference => !preference.expires_at || Date.parse(preference.expires_at) > now)
      .map(preference => ({
        id: preference.id,
        kind: preference.kind,
        claim: preference.claim,
        dimension: preference.dimension,
        scope: preference.scope,
        exclusions: preference.exclusions,
        confidence: preference.confidence,
        sensitivity: preference.sensitivity,
        conflicts_with: preference.conflicts_with ?? [],
      })),
    safety_invariants: model.safety_invariants,
    ...(model.load_error ? { load_error: model.load_error } : {}),
  }
}

function countPendingCandidates(dir) {
  try {
    let count = 0
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue
      const batch = JSON.parse(readFileSync(join(dir, name), 'utf8'))
      count += (batch.candidates ?? []).filter(candidate => candidate.status === 'candidate').length
    }
    return count
  } catch {
    return null
  }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function appendJsonLine(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, `${JSON.stringify(value)}\n`, 'utf8')
}
