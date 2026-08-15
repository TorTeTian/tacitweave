import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { sanitizeId } from './core.js'
import {
  acceptCandidate,
  createCalibrationCandidate,
  createEmptyModel,
  mergeCandidateRecords,
  recordsConflict,
  refreshCandidateScores,
  rejectCandidate,
  upgradeModel,
} from './weavespec.js'

export class MemoryStore {
  constructor(memoryDir, options = {}) {
    this.root = resolve(memoryDir)
    this.projectId = sanitizeId(options.projectId ?? 'current-project')
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
    const model = JSON.stringify(toRuntimeModel(this.readModel(), this.projectId), null, 2)
    const tentative = JSON.stringify(this.runtimeCandidates(), null, 2)
    const review = this.reviewSummary()
    let notes = ''
    try { notes = readFileSync(this.notesPath, 'utf8') } catch {}
    const text = [
      '## Explicit Personal Model (user-reviewable local files)',
      'This file follows WeaveSpec. Safety invariants and confirmed decision boundaries outrank general preferences. Revoked, superseded, rejected, and expired records never affect behavior.',
      '### confirmed_memory',
      model,
      '### tentative_project_candidates',
      'These candidates may help interpret low-risk, reversible work in this project. They are not durable memory, do not transfer across projects, and never authorize high-risk, irreversible, external, private, financial, medical, legal, publishing, or production actions. Ignore candidates with conflicts.',
      tentative,
      '### memory_review_status',
      JSON.stringify(review, null, 2),
      '### current_context.md',
      notes,
    ].join('\n\n')
    return text.slice(0, maxChars)
  }

  inspect() {
    return {
      memory_dir: this.root,
      project_id: this.projectId,
      personal_model_file: this.modelPath,
      current_context_file: this.notesPath,
      feedback_file: this.feedbackPath,
      policies_dir: this.policiesDir,
      sources_dir: this.sourcesDir,
      candidates_dir: this.candidatesDir,
      review: this.reviewSummary(),
      tentative_project_candidates: this.runtimeCandidates(),
      personal_model: this.readModel(),
    }
  }

  savePolicy({ agentId, turn, policy, outcome }) {
    const safeAgent = sanitizeId(agentId)
    const dir = join(this.policiesDir, safeAgent)
    mkdirSync(dir, { recursive: true })
    const timestamp = new Date().toISOString()
    const record = {
      schema_version: 2,
      timestamp,
      agent_id: String(agentId),
      turn,
      project_id: this.projectId,
      policy,
      calibration: outcome,
    }
    const path = join(dir, `turn-${Number.isInteger(turn) ? turn : 'unknown'}.json`)
    writeJson(path, record)
    appendJsonLine(this.feedbackPath, record)

    let memoryCandidate = null
    if (outcome.status === 'adjusted' && outcome.correction) {
      memoryCandidate = createCalibrationCandidate({
        correction: outcome.correction,
        policy,
        projectId: this.projectId,
        agentId,
        turn,
        createdAt: timestamp,
      })
      if (memoryCandidate) memoryCandidate = this.saveCandidate(memoryCandidate)
    }
    return { policyFile: path, memoryCandidate }
  }

  saveCandidate(candidateInput) {
    let candidate = structuredClone(candidateInput)
    const batches = this.loadBatches()
    const duplicate = findCandidateByClaim(batches, candidate.claim)
    if (duplicate) {
      const merged = mergeCandidateRecords(duplicate.candidate, candidate)
      Object.assign(duplicate.candidate, merged)
      markConflictsAcrossQueue(batches, duplicate.candidate, this.readModel())
      refreshCandidateScores(duplicate.candidate)
      for (const changed of batches.filter(item => item.changed || item.path === duplicate.path)) {
        writeJsonAtomic(changed.path, changed.batch)
      }
      return publicCandidate(duplicate.candidate)
    }

    markConflictsAcrossQueue(batches, candidate, this.readModel())
    refreshCandidateScores(candidate)
    for (const changed of batches.filter(item => item.changed)) writeJsonAtomic(changed.path, changed.batch)
    const batch = {
      protocol: 'weavespec/0.2',
      batch_id: `batch-${candidate.id.replace(/^candidate-/, '')}`,
      source_id: candidate.evidence[0]?.source_id ?? 'feedback',
      created_at: candidate.evidence[0]?.timestamp ?? new Date().toISOString(),
      review_required: true,
      candidates: [candidate],
    }
    writeJson(join(this.candidatesDir, `${batch.batch_id}.json`), batch)
    return publicCandidate(candidate)
  }

  listCandidates(status = 'candidate') {
    return this.loadBatches()
      .flatMap(({ batch }) => batch.candidates ?? [])
      .filter(candidate => status === 'all' || candidate.status === status)
      .map(refreshCandidateScores)
  }

  runtimeCandidates() {
    const now = Date.now()
    return this.listCandidates('candidate')
      .filter(candidate => !candidate.expires_at || Date.parse(candidate.expires_at) > now)
      .filter(candidate => candidate.activation?.project)
      .filter(candidate => candidate.scope?.projects?.includes(this.projectId))
      .filter(candidate => !(candidate.conflicts_with?.length))
      .filter(candidate => candidate.confidence >= 0.5)
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 5)
      .map(publicCandidate)
  }

  reviewQueue(limit = 2) {
    const now = Date.now()
    return this.reviewCandidates()
      .filter(candidate => !candidate.review?.deferred_until || Date.parse(candidate.review.deferred_until) <= now)
      .sort((a, b) => (b.review?.priority ?? 0) - (a.review?.priority ?? 0) || b.confidence - a.confidence)
      .slice(0, limit)
      .map(publicCandidate)
  }

  reviewSummary() {
    const pending = this.reviewCandidates()
    const ready = this.reviewQueue(20)
    return {
      pending: pending.length,
      conflicted: pending.filter(item => item.conflicts_with?.length).length,
      recommended: ready.filter(item => (item.review?.priority ?? 0) >= 35).length,
      next: ready.slice(0, 2).map(item => ({ id: item.id, claim: item.claim, priority: item.review?.priority ?? 0 })),
    }
  }

  reviewCandidates() {
    return this.listCandidates('candidate').filter(candidate => {
      const projects = candidate.scope?.projects ?? []
      return projects.length === 0 || projects.includes(this.projectId)
    })
  }

  applyReview(id, action, options = {}) {
    const found = this.findCandidate(id)
    if (!found) throw new Error(`Candidate not found: ${id}`)
    if (found.candidate.status !== 'candidate') throw new Error(`Candidate is already ${found.candidate.status}: ${id}`)
    if (action === 'accept') {
      const model = acceptCandidate(this.readModel(), found.candidate, { claim: options.claim })
      const accepted = [...model.preferences, ...model.decision_boundaries]
        .find(item => item.id === id.replace(/^candidate-/, 'pref-') || item.claim === (options.claim ?? found.candidate.claim))
      found.candidate.status = 'user_confirmed'
      found.candidate.last_reviewed_at = new Date().toISOString()
      found.candidate.accepted_preference_id = accepted?.id ?? null
      writeJsonAtomic(found.path, found.batch)
      writeJsonAtomic(this.modelPath, model)
      return { action, candidate_id: id, memory_id: accepted?.id ?? null }
    }
    if (action === 'reject') {
      Object.assign(found.candidate, rejectCandidate(found.candidate))
      writeJsonAtomic(found.path, found.batch)
      return { action, candidate_id: id }
    }
    const deferredUntil = options.deferredUntil ?? new Date(Date.now() + 7 * 86400000).toISOString()
    found.candidate.review = { ...(found.candidate.review ?? {}), deferred_until: deferredUntil }
    writeJsonAtomic(found.path, found.batch)
    return { action: 'defer', candidate_id: id, deferred_until: deferredUntil }
  }

  findCandidate(id) {
    for (const item of this.loadBatches()) {
      const candidate = item.batch.candidates?.find(entry => entry.id === id)
      if (candidate) return { ...item, candidate }
    }
    return null
  }

  loadBatches() {
    try {
      return readdirSync(this.candidatesDir)
        .filter(name => name.endsWith('.json'))
        .sort()
        .map(name => {
          const path = join(this.candidatesDir, name)
          return { path, batch: JSON.parse(readFileSync(path, 'utf8')), changed: false }
        })
    } catch {
      return []
    }
  }
}

function toRuntimeModel(model, projectId) {
  const now = Date.now()
  const active = record => record.status === 'user_confirmed' && (!record.expires_at || Date.parse(record.expires_at) > now)
  const project = record => !(record.scope?.projects?.length) || record.scope.projects.includes(projectId)
  return {
    schema_version: model.schema_version,
    subject: { id: model.subject?.id ?? 'local-user' },
    updated_at: model.updated_at,
    decision_boundaries: (model.decision_boundaries ?? []).filter(active).filter(project).map(runtimeRecord),
    preferences: (model.preferences ?? []).filter(active).filter(project).map(runtimeRecord),
    safety_invariants: model.safety_invariants,
  }
}

function runtimeRecord(record) {
  return {
    id: record.id,
    kind: record.kind,
    claim: record.claim,
    dimension: record.dimension,
    scope: record.scope,
    exclusions: record.exclusions,
    confidence: record.confidence,
    sensitivity: record.sensitivity,
    conflicts_with: record.conflicts_with ?? [],
  }
}

function publicCandidate(candidate) {
  return {
    id: candidate.id,
    kind: candidate.kind,
    claim: candidate.claim,
    dimension: candidate.dimension,
    scope: candidate.scope,
    exclusions: candidate.exclusions,
    confidence: candidate.confidence,
    confidence_basis: candidate.confidence_basis,
    sensitivity: candidate.sensitivity,
    conflicts_with: candidate.conflicts_with ?? [],
    activation: candidate.activation,
    review: candidate.review,
  }
}

function markConflictsAcrossQueue(batches, candidate, model) {
  for (const item of batches) {
    for (const existing of item.batch.candidates ?? []) {
      if (existing.id === candidate.id || existing.status !== 'candidate') continue
      if (!recordsConflict(existing, candidate)) continue
      existing.conflicts_with = unique([...(existing.conflicts_with ?? []), candidate.id])
      candidate.conflicts_with = unique([...(candidate.conflicts_with ?? []), existing.id])
      refreshCandidateScores(existing)
      item.changed = true
    }
  }
  for (const existing of [...(model.preferences ?? []), ...(model.decision_boundaries ?? [])]) {
    if (existing.status !== 'user_confirmed' || !recordsConflict(existing, candidate)) continue
    candidate.conflicts_with = unique([...(candidate.conflicts_with ?? []), existing.id])
  }
}

function findCandidateByClaim(batches, claim) {
  const key = claimKey(claim)
  for (const item of batches) {
    const candidate = item.batch.candidates?.find(entry => entry.status === 'candidate' && claimKey(entry.claim) === key)
    if (candidate) return { ...item, candidate }
  }
  return null
}

function claimKey(value) {
  return String(value).toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

function unique(values) {
  return [...new Set(values.filter(Boolean))]
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(temporary, path)
}

function appendJsonLine(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, `${JSON.stringify(value)}\n`, 'utf8')
}
