import { createHash } from 'node:crypto'
import { basename, extname } from 'node:path'

export const WEAVESPEC_VERSION = 'weavespec/0.1'

export const DEFAULT_SAFETY_INVARIANTS = [
  'Destructive, irreversible, financial, privacy-sensitive, publishing, production, and external communication actions require explicit confirmation.',
  'A general preference for autonomy never overrides a narrower risk boundary.',
]

const PREFERENCE_MARKERS = [
  /我(?:希望|偏好|习惯|通常|一般|不喜欢|需要|要求)/i,
  /(?:不用|无需|不要|不必|必须|应该|请)(?:先|再)?(?:问|询问|确认|解释|替我|直接)/i,
  /(?:由我|让我)(?:决定|选择|确认)/i,
  /你可以(?:直接|自行|自己)|交给你(?:决定|处理)/i,
  /\bI\s+(?:prefer|want|usually|generally|need|expect|dislike)\b/i,
  /\b(?:do not|don't|never|always)\s+(?:ask|decide|send|publish|share|delete|explain)\b/i,
  /\bask me before\b|\bleave .* to me\b|\byou can (?:decide|handle|choose|go ahead)\b/i,
]

const STANDARD_AUTONOMY_EXCLUSIONS = [
  'destructive_operations',
  'irreversible_actions',
  'financial_transactions',
  'privacy_sensitive_disclosure',
  'external_communication',
  'public_publishing',
  'production_changes',
]

export function createEmptyModel(subjectId = 'local-user') {
  return {
    schema_version: WEAVESPEC_VERSION,
    subject: { id: cleanId(subjectId), label: null },
    updated_at: null,
    preferences: [],
    safety_invariants: [...DEFAULT_SAFETY_INVARIANTS],
  }
}

export function detectFormat(inputPath, text) {
  const name = basename(inputPath).toLowerCase()
  if (name === 'conversations.json') return 'chatgpt'
  if (extname(name) === '.jsonl') return 'jsonl'
  if (['.md', '.markdown', '.txt'].includes(extname(name))) return 'markdown'
  try {
    const parsed = JSON.parse(text)
    if (Array.isArray(parsed) && parsed.some(item => item?.mapping || item?.conversation_id)) return 'chatgpt'
    if (Array.isArray(parsed) && parsed.every(item => item?.role && item?.content != null)) return 'json'
  } catch {}
  return 'markdown'
}

export function parseImportedContent(text, format, inputPath = 'input') {
  const selected = format === 'auto' ? detectFormat(inputPath, text) : format
  if (selected === 'chatgpt') return { format: selected, messages: parseChatGpt(text) }
  if (selected === 'jsonl') return { format: selected, messages: parseJsonl(text) }
  if (selected === 'json') return { format: selected, messages: parseJsonMessages(text) }
  if (selected === 'markdown') return { format: selected, messages: parseMarkdown(text) }
  throw new Error(`Unsupported format: ${selected}`)
}

export function buildSourceEnvelope({ messages, format, inputPath, importedAt = new Date().toISOString() }) {
  const normalized = messages
    .filter(message => message.role === 'user')
    .map((message, index) => ({
      id: cleanText(message.id, 200) || `message-${index + 1}`,
      role: 'user',
      timestamp: normalizeTimestamp(message.timestamp),
      content: redactSensitive(cleanText(message.content, 50000)),
    }))
    .filter(message => message.content)
  const digest = sha256(JSON.stringify(normalized))
  return {
    protocol: WEAVESPEC_VERSION,
    source_id: `source-${digest.slice(0, 20)}`,
    source_type: format,
    original_name: basename(inputPath),
    imported_at: importedAt,
    content_sha256: digest,
    privacy: {
      stored_locally: true,
      redaction_applied: true,
      contains_user_text: true,
    },
    messages: normalized,
  }
}

export function extractCandidates(source, createdAt = new Date().toISOString()) {
  const candidates = []
  for (const message of source.messages) {
    for (const excerpt of splitStatements(message.content)) {
      if (!PREFERENCE_MARKERS.some(pattern => pattern.test(excerpt))) continue
      const dimension = inferDimension(excerpt)
      const kind = inferKind(excerpt, dimension)
      const scope = inferScope(excerpt)
      const exclusions = dimension === 'autonomy' ? [...STANDARD_AUTONOMY_EXCLUSIONS] : inferExclusions(excerpt)
      const evidence = {
        source_id: source.source_id,
        message_id: message.id,
        timestamp: message.timestamp,
        excerpt,
        excerpt_sha256: sha256(excerpt),
      }
      const id = `candidate-${sha256(`${source.source_id}\n${excerpt}`).slice(0, 20)}`
      candidates.push({
        id,
        kind,
        claim: excerpt,
        dimension,
        scope,
        exclusions,
        evidence: [evidence],
        confidence: inferConfidence(excerpt),
        status: 'candidate',
        sensitivity: inferSensitivity(excerpt),
        conflicts_with: [],
        confirmed_at: null,
        last_reviewed_at: null,
        expires_at: kind === 'temporary_context' ? createdAt : null,
      })
    }
  }
  const unique = deduplicateCandidates(candidates)
  markConflicts(unique)
  return {
    protocol: WEAVESPEC_VERSION,
    batch_id: `batch-${sha256(`${source.source_id}\n${createdAt}`).slice(0, 20)}`,
    source_id: source.source_id,
    created_at: createdAt,
    review_required: true,
    candidates: unique,
  }
}

export function upgradeModel(model, subjectId = 'local-user') {
  if (model?.schema_version === WEAVESPEC_VERSION) return structuredClone(model)
  const upgraded = createEmptyModel(model?.user_label || subjectId)
  upgraded.updated_at = model?.updated_at ?? null
  upgraded.safety_invariants = Array.isArray(model?.safety_invariants)
    ? [...model.safety_invariants]
    : [...DEFAULT_SAFETY_INVARIANTS]
  upgraded.preferences = Array.isArray(model?.preferences)
    ? model.preferences.map((preference, index) => upgradePreference(preference, index))
    : []
  return upgraded
}

export function acceptCandidate(modelInput, candidateInput, overrides = {}, reviewedAt = new Date().toISOString()) {
  const model = upgradeModel(modelInput)
  const candidate = structuredClone(candidateInput)
  candidate.claim = cleanText(overrides.claim ?? candidate.claim, 2000)
  if (!candidate.claim) throw new Error('Accepted preference claim must not be empty')
  candidate.scope = applyScopeOverrides(candidate.scope, overrides)
  candidate.exclusions = mergeUnique(candidate.exclusions, listValue(overrides.exclusions))
  candidate.status = 'user_confirmed'
  candidate.confirmed_at = candidate.confirmed_at ?? reviewedAt
  candidate.last_reviewed_at = reviewedAt
  candidate.expires_at = overrides.expiresAt ?? candidate.expires_at ?? null
  candidate.id = candidate.id.replace(/^candidate-/, 'pref-')

  const duplicate = model.preferences.find(item => normalizedClaim(item.claim) === normalizedClaim(candidate.claim))
  if (duplicate) {
    duplicate.evidence = mergeEvidence(duplicate.evidence, candidate.evidence)
    duplicate.scope = mergeScope(duplicate.scope, candidate.scope)
    duplicate.exclusions = mergeUnique(duplicate.exclusions, candidate.exclusions)
    duplicate.confidence = Math.max(Number(duplicate.confidence) || 0, Number(candidate.confidence) || 0)
    duplicate.status = 'user_confirmed'
    duplicate.last_reviewed_at = reviewedAt
  } else {
    for (const existing of model.preferences) {
      if (sameConflictGroup(existing.dimension, candidate.dimension) && claimsConflict(existing.claim, candidate.claim)) {
        existing.conflicts_with = mergeUnique(existing.conflicts_with, [candidate.id])
        candidate.conflicts_with = mergeUnique(candidate.conflicts_with, [existing.id])
      }
    }
    model.preferences.push(candidate)
  }
  model.updated_at = reviewedAt
  return model
}

export function rejectCandidate(candidateInput, reviewedAt = new Date().toISOString()) {
  return {
    ...structuredClone(candidateInput),
    status: 'rejected',
    last_reviewed_at: reviewedAt,
  }
}

export function validateWeaveModel(model) {
  const errors = []
  if (model?.schema_version !== WEAVESPEC_VERSION) errors.push(`schema_version must be ${WEAVESPEC_VERSION}`)
  if (!model?.subject?.id) errors.push('subject.id is required')
  if (!Array.isArray(model?.preferences)) errors.push('preferences must be an array')
  for (const [index, preference] of (model?.preferences ?? []).entries()) {
    if (!preference.id) errors.push(`preferences[${index}].id is required`)
    if (!preference.claim) errors.push(`preferences[${index}].claim is required`)
    if (preference.status !== 'user_confirmed') errors.push(`preferences[${index}] must be user_confirmed`)
    if (!Array.isArray(preference.evidence) || !preference.evidence.length) errors.push(`preferences[${index}].evidence is required`)
  }
  return { valid: errors.length === 0, errors }
}

export function redactSensitive(text) {
  return String(text)
    .replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]')
    .replace(/\b(?:sk|gh[pousr])-[A-Za-z0-9_-]{16,}\b|\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[REDACTED_TOKEN]')
    .replace(/\b(api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*["']?[^\s"']{8,}["']?/gi, '$1=[REDACTED]')
}

export function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex')
}

function parseChatGpt(text) {
  const conversations = JSON.parse(text)
  if (!Array.isArray(conversations)) throw new Error('ChatGPT export must be a JSON array')
  const messages = []
  for (const conversation of conversations) {
    if (conversation?.mapping && typeof conversation.mapping === 'object') {
      const nodes = Object.values(conversation.mapping)
        .map(node => node?.message)
        .filter(Boolean)
        .sort((a, b) => Number(a.create_time ?? 0) - Number(b.create_time ?? 0))
      for (const message of nodes) messages.push(normalizeMessage(message))
      continue
    }
    for (const message of conversation?.messages ?? []) messages.push(normalizeMessage(message))
  }
  return messages.filter(Boolean)
}

function parseJsonl(text) {
  const messages = []
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue
    try {
      const record = JSON.parse(line)
      const normalized = normalizeMessage(record, index)
      if (normalized) messages.push(normalized)
    } catch (error) {
      throw new Error(`Invalid JSONL at line ${index + 1}: ${error.message}`)
    }
  }
  return messages
}

function parseJsonMessages(text) {
  const parsed = JSON.parse(text)
  if (!Array.isArray(parsed)) throw new Error('JSON message input must be an array')
  return parsed.map(normalizeMessage).filter(Boolean)
}

function parseMarkdown(text) {
  return splitStatements(text).map((content, index) => ({
    id: `markdown-${index + 1}`,
    role: 'user',
    timestamp: null,
    content,
  }))
}

function normalizeMessage(message, index = 0) {
  const role = message?.author?.role ?? message?.role ?? 'unknown'
  const raw = message?.content?.parts ?? message?.content?.text ?? message?.content ?? message?.text
  const content = Array.isArray(raw)
    ? raw.filter(item => typeof item === 'string').join('\n')
    : typeof raw === 'string' ? raw : ''
  if (!content) return null
  return {
    id: String(message?.id ?? `message-${index + 1}`),
    role,
    timestamp: normalizeTimestamp(message?.create_time ?? message?.timestamp ?? null),
    content,
  }
}

function splitStatements(text) {
  return String(text)
    .replace(/^#{1,6}\s+/gm, '')
    .split(/\r?\n+|(?<=[。！？!?;；])\s*/u)
    .map(item => item.replace(/^[-*+]\s+/, '').trim())
    .filter(item => item.length >= 4 && item.length <= 2000)
}

function inferDimension(text) {
  if (/(隐私|私人|保密|不要分享|don't share|private|confidential)/i.test(text)) return 'privacy'
  if (/(由我决定|让我选择|不要替我|ask me before|leave .* to me|final decision)/i.test(text)) return 'decision_ownership'
  if (/(不用问|无需确认|不要问我|你可以直接|自行决定|don't ask|without asking|you can decide|use your judgment)/i.test(text)) return 'autonomy'
  if (/(先问|必须确认|需要确认|ask me|confirm)/i.test(text)) return 'confirmation'
  if (/(解释|原因|理由|explain|rationale|reasoning)/i.test(text)) return 'explanation'
  if (/(格式|排版|引用|format|style|citation)/i.test(text)) return 'format'
  if (/(语气|简洁|详细|邮件|沟通|tone|concise|detailed|email)/i.test(text)) return 'communication'
  return 'other'
}

function inferKind(text, dimension) {
  if (dimension === 'decision_ownership' || dimension === 'confirmation' || dimension === 'privacy') return 'decision_boundary'
  if (/(今天|本轮|当前|这次|today|this time|this task|current project)/i.test(text)) return 'temporary_context'
  return 'interaction_preference'
}

function inferScope(text) {
  const domains = []
  const actions = []
  if (/(代码|工程|脚本|变量|测试|仓库|code|engineering|script|variable|test|repository)/i.test(text)) domains.push('software_engineering')
  if (/(科研|论文|分析方法|实验|research|paper|analysis method|experiment)/i.test(text)) domains.push('scientific_research')
  if (/(邮件|消息|沟通|email|message|communication)/i.test(text)) domains.push('communication')
  if (/(健康|医疗|药|health|medical|medication)/i.test(text)) domains.push('health')
  if (/(写|编辑|修改|write|edit|rename)/i.test(text)) actions.push('content_or_file_editing')
  if (/(发送|发布|分享|send|publish|share)/i.test(text)) actions.push('external_communication')
  if (/(删除|清理|delete|remove)/i.test(text)) actions.push('deletion')
  const risk = /(?:低风险|low[- ]risk|routine)/i.test(text) ? ['low'] : ['unspecified']
  const reversibility = /(?:可逆|版本控制|reversible|version[- ]controlled)/i.test(text) ? ['reversible'] : ['unspecified']
  return {
    domains: domains.length ? domains : ['unspecified'],
    actions: actions.length ? actions : ['unspecified'],
    risk,
    reversibility,
    projects: [],
  }
}

function inferExclusions(text) {
  const exclusions = []
  if (/(不要分享|don't share)/i.test(text)) exclusions.push('external_disclosure')
  if (/(不要发送|don't send)/i.test(text)) exclusions.push('sending')
  if (/(不要发布|don't publish)/i.test(text)) exclusions.push('public_publishing')
  return exclusions
}

function inferConfidence(text) {
  if (/(我希望|我偏好|我要求|必须|不要|不用|I prefer|I want|always|never|don't)/i.test(text)) return 0.85
  return 0.7
}

function inferSensitivity(text) {
  return /(健康|医疗|病|合同|法律|财务|密码|隐私|health|medical|legal|financial|password|private)/i.test(text)
    ? 'sensitive'
    : 'normal'
}

function deduplicateCandidates(candidates) {
  const byClaim = new Map()
  for (const candidate of candidates) {
    const key = normalizedClaim(candidate.claim)
    const existing = byClaim.get(key)
    if (!existing) byClaim.set(key, candidate)
    else existing.evidence = mergeEvidence(existing.evidence, candidate.evidence)
  }
  return [...byClaim.values()]
}

function markConflicts(candidates) {
  for (let i = 0; i < candidates.length; i += 1) {
    for (let j = i + 1; j < candidates.length; j += 1) {
      const left = candidates[i]
      const right = candidates[j]
      if (sameConflictGroup(left.dimension, right.dimension) && claimsConflict(left.claim, right.claim)) {
        left.conflicts_with = mergeUnique(left.conflicts_with, [right.id])
        right.conflicts_with = mergeUnique(right.conflicts_with, [left.id])
      }
    }
  }
}

function claimsConflict(left, right) {
  const positive = /(可以|直接|不用|无需|不要问|don't ask|without asking|you can|use your judgment)/i
  const restrictive = /(不可以|不要替我|必须确认|先问|ask me before|must confirm|do not decide)/i
  return (positive.test(left) && restrictive.test(right)) || (restrictive.test(left) && positive.test(right))
}

function sameConflictGroup(left, right) {
  if (left === right) return true
  const control = new Set(['autonomy', 'confirmation', 'decision_ownership'])
  return control.has(left) && control.has(right)
}

function upgradePreference(preference, index) {
  const evidenceItems = Array.isArray(preference.evidence) ? preference.evidence : []
  const evidence = evidenceItems.length
    ? evidenceItems.map((item, evidenceIndex) => {
      const excerpt = typeof item === 'string' ? item : String(item?.excerpt ?? item?.claim ?? 'legacy evidence')
      return {
        source_id: typeof item === 'object' ? String(item.source_id ?? 'legacy-model') : 'legacy-model',
        message_id: typeof item === 'object' ? item.message_id ?? null : `legacy-${evidenceIndex + 1}`,
        timestamp: typeof item === 'object' ? normalizeTimestamp(item.timestamp) : null,
        excerpt,
        excerpt_sha256: sha256(excerpt),
      }
    })
    : [{ source_id: 'legacy-model', message_id: null, timestamp: null, excerpt: preference.claim ?? 'legacy preference', excerpt_sha256: sha256(preference.claim ?? 'legacy preference') }]
  return {
    id: cleanId(preference.id || `legacy-${index + 1}`),
    kind: 'interaction_preference',
    claim: String(preference.claim ?? ''),
    dimension: allowedDimension(preference.dimension),
    scope: Array.isArray(preference.scope)
      ? { domains: preference.scope, actions: ['unspecified'], risk: ['unspecified'], reversibility: ['unspecified'], projects: [] }
      : normalizeScope(preference.scope),
    exclusions: Array.isArray(preference.exceptions) ? preference.exceptions : listValue(preference.exclusions),
    evidence,
    confidence: clamp(Number(preference.confidence ?? 1), 0, 1),
    status: 'user_confirmed',
    sensitivity: 'normal',
    conflicts_with: [],
    confirmed_at: null,
    last_reviewed_at: null,
    expires_at: null,
  }
}

function applyScopeOverrides(scope, overrides) {
  const result = normalizeScope(scope)
  if (overrides.domains?.length) result.domains = listValue(overrides.domains)
  if (overrides.actions?.length) result.actions = listValue(overrides.actions)
  if (overrides.risk?.length) result.risk = listValue(overrides.risk)
  if (overrides.reversibility?.length) result.reversibility = listValue(overrides.reversibility)
  if (overrides.projects?.length) result.projects = listValue(overrides.projects)
  return result
}

function normalizeScope(scope = {}) {
  return {
    domains: listValue(scope.domains).length ? listValue(scope.domains) : ['unspecified'],
    actions: listValue(scope.actions).length ? listValue(scope.actions) : ['unspecified'],
    risk: listValue(scope.risk).length ? listValue(scope.risk) : ['unspecified'],
    reversibility: listValue(scope.reversibility).length ? listValue(scope.reversibility) : ['unspecified'],
    projects: listValue(scope.projects),
  }
}

function mergeScope(left, right) {
  const a = normalizeScope(left)
  const b = normalizeScope(right)
  return {
    domains: mergeUnique(a.domains, b.domains),
    actions: mergeUnique(a.actions, b.actions),
    risk: mergeUnique(a.risk, b.risk),
    reversibility: mergeUnique(a.reversibility, b.reversibility),
    projects: mergeUnique(a.projects, b.projects),
  }
}

function mergeEvidence(left = [], right = []) {
  const map = new Map()
  for (const item of [...left, ...right]) {
    const key = [item.source_id, item.message_id ?? '', item.excerpt_sha256 || sha256(item.excerpt)].join(':')
    map.set(key, item)
  }
  return [...map.values()]
}

function mergeUnique(left = [], right = []) {
  return [...new Set([...listValue(left), ...listValue(right)].filter(Boolean))]
}

function listValue(value) {
  if (Array.isArray(value)) return value.map(item => cleanText(item, 300)).filter(Boolean)
  if (value == null || value === '') return []
  return String(value).split(',').map(item => cleanText(item, 300)).filter(Boolean)
}

function allowedDimension(value) {
  return ['autonomy', 'confirmation', 'decision_ownership', 'communication', 'explanation', 'privacy', 'format', 'other'].includes(value)
    ? value
    : 'other'
}

function normalizedClaim(value) {
  return String(value).toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

function normalizeTimestamp(value) {
  if (value == null || value === '') return null
  const date = typeof value === 'number' ? new Date(value * (value < 1e12 ? 1000 : 1)) : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function cleanText(value, maxLength) {
  return String(value ?? '').trim().slice(0, maxLength)
}

function cleanId(value) {
  return String(value ?? 'local-user').replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 128) || 'local-user'
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}
