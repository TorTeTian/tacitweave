import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { sanitizeId } from './core.js'

const EMPTY_MODEL = {
  schema_version: 1,
  user_label: 'local-user',
  updated_at: null,
  preferences: [],
  safety_invariants: [
    'Destructive, irreversible, financial, privacy-sensitive, publishing, and external communication actions require explicit confirmation.',
    'A general preference for autonomy never overrides a narrower risk boundary.',
  ],
}

export class MemoryStore {
  constructor(memoryDir) {
    this.root = resolve(memoryDir)
    this.modelPath = join(this.root, 'personal_model.json')
    this.notesPath = join(this.root, 'current_context.md')
    this.feedbackPath = join(this.root, 'feedback.jsonl')
    this.policiesDir = join(this.root, 'policies')
    this.ensureInitialized()
  }

  ensureInitialized() {
    mkdirSync(this.root, { recursive: true })
    mkdirSync(this.policiesDir, { recursive: true })
    if (!existsSync(this.modelPath)) writeJson(this.modelPath, EMPTY_MODEL)
    if (!existsSync(this.notesPath)) {
      writeFileSync(this.notesPath, '# Current context\n\nAdd project- or user-confirmed context here.\n', 'utf8')
    }
  }

  readModel() {
    try {
      return JSON.parse(readFileSync(this.modelPath, 'utf8'))
    } catch (error) {
      return { ...EMPTY_MODEL, load_error: String(error) }
    }
  }

  renderContext(maxChars = 12000) {
    const model = JSON.stringify(this.readModel(), null, 2)
    let notes = ''
    try { notes = readFileSync(this.notesPath, 'utf8') } catch {}
    const text = [
      '## Explicit Personal Model (user-reviewable local files)',
      `Memory directory: ${this.root}`,
      'Treat explicit user-confirmed preferences as stronger than inferred preferences. Apply every preference only within its scope and exceptions. Safety invariants override autonomy preferences.',
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

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function appendJsonLine(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, `${JSON.stringify(value)}\n`, 'utf8')
}
