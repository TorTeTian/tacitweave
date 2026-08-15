import { createHash } from 'node:crypto'
import { basename, extname } from 'node:path'

export const WEAVESPEC_VERSION = 'weavespec/0.2'
export const PREVIOUS_WEAVESPEC_VERSION = 'weavespec/0.1'

export const DEFAULT_SAFETY_INVARIANTS = [
  'Destructive, irreversible, financial, privacy-sensitive, publishing, production, and external communication actions require explicit confirmation.',
  'A general preference for autonomy never overrides a narrower risk boundary.',
]

const PREFERENCE_MARKERS = [
  /我(?:希望|偏好|习惯|通常|一般|不喜欢|要求)/i,
  /(?:不用|无需|不要|不必|必须|应该|请)(?:先|再)?(?:问|询问|确认|解释|替我|直接)/i,
  /(?:由我|让我)(?:决定|选择|确认)/i,
  /你可以(?:直接|自行|自己)|交给你(?:决定|处理)/i,
  /\bI\s+(?:prefer|want|usually|generally|expect|dislike)\b/i,
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
    decision_boundaries: [],
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
  let messages
  if (selected === 'chatgpt') messages = parseChatGpt(text)
  else if (selected === 'jsonl') messages = parseJsonl(text)
  else if (selected === 'json') messages = parseJsonMessages(text)
  else if (selected === 'markdown') messages = parseMarkdown(text)
  else throw new Error(`Unsupported format: ${selected}`)
  return { format: selected, messages: expandReferencedConversationMessages(messages) }
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
      const candidate = {
        id,
        kind,
        claim: excerpt,
        dimension,
        scope,
        exclusions,
        evidence: [evidence],
        confidence: 0,
        confidence_basis: createConfidenceBasis({ evidence: [evidence], scope, explicit: true }),
        status: 'candidate',
        sensitivity: inferSensitivity(excerpt),
        conflicts_with: [],
        confirmed_at: null,
        last_reviewed_at: null,
        expires_at: kind === 'temporary_context' ? new Date(Date.parse(createdAt) + 7 * 86400000).toISOString() : null,
        activation: candidateActivation(scope),
        review: { priority: 0, reasons: [], deferred_until: null },
        revoked_at: null,
        revocation_reason: null,
        supersedes: [],
      }
      refreshCandidateScores(candidate)
      candidates.push(candidate)
    }
  }
  const unique = deduplicateCandidates(candidates)
  markConflicts(unique)
  unique.forEach(refreshCandidateScores)
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
  if (model?.schema_version === WEAVESPEC_VERSION) return normalizeCurrentModel(model)
  const upgraded = createEmptyModel(model?.user_label || subjectId)
  upgraded.updated_at = model?.updated_at ?? null
  upgraded.safety_invariants = Array.isArray(model?.safety_invariants)
    ? [...model.safety_invariants]
    : [...DEFAULT_SAFETY_INVARIANTS]
  const legacyPreferences = Array.isArray(model?.preferences)
    ? model.preferences.map((preference, index) => upgradePreference(preference, index))
    : []
  const legacyBoundaries = Array.isArray(model?.decision_boundaries)
    ? model.decision_boundaries.map((preference, index) => upgradePreference(preference, index, 'decision_boundary'))
    : []
  upgraded.preferences = legacyPreferences.filter(item => item.kind !== 'decision_boundary')
  upgraded.decision_boundaries = [
    ...legacyBoundaries,
    ...legacyPreferences.filter(item => item.kind === 'decision_boundary'),
  ]
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
  candidate.confidence_basis = createConfidenceBasis({
    evidence: candidate.evidence,
    scope: candidate.scope,
    explicit: true,
    confirmed: true,
    conflicts: candidate.conflicts_with?.length ?? 0,
  })
  candidate.confidence = scoreConfidence(candidate.confidence_basis)
  candidate.activation = durableActivation(candidate.scope)
  candidate.review = { priority: 0, reasons: ['user_confirmed'], deferred_until: null }

  const collection = candidate.kind === 'decision_boundary' ? model.decision_boundaries : model.preferences
  const duplicate = collection.find(item => normalizedClaim(item.claim) === normalizedClaim(candidate.claim))
  if (duplicate) {
    duplicate.evidence = mergeEvidence(duplicate.evidence, candidate.evidence)
    duplicate.scope = mergeScope(duplicate.scope, candidate.scope)
    duplicate.exclusions = mergeUnique(duplicate.exclusions, candidate.exclusions)
    duplicate.confidence_basis = createConfidenceBasis({
      evidence: duplicate.evidence,
      scope: duplicate.scope,
      explicit: true,
      confirmed: true,
      conflicts: duplicate.conflicts_with?.length ?? 0,
    })
    duplicate.confidence = scoreConfidence(duplicate.confidence_basis)
    duplicate.status = 'user_confirmed'
    duplicate.last_reviewed_at = reviewedAt
  } else {
    for (const existing of [...model.preferences, ...model.decision_boundaries]) {
      if (sameConflictGroup(existing.dimension, candidate.dimension) && claimsConflict(existing.claim, candidate.claim)) {
        existing.conflicts_with = mergeUnique(existing.conflicts_with, [candidate.id])
        candidate.conflicts_with = mergeUnique(candidate.conflicts_with, [existing.id])
      }
    }
    collection.push(candidate)
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
  if (!Array.isArray(model?.decision_boundaries)) errors.push('decision_boundaries must be an array')
  validateRecords(model?.preferences, 'preferences', errors)
  validateRecords(model?.decision_boundaries, 'decision_boundaries', errors)
  return { valid: errors.length === 0, errors }
}

export function createCalibrationCandidate({ correction, policy, projectId = 'current-project', agentId = 'unknown', turn = null, createdAt = new Date().toISOString() }) {
  const excerpt = cleanText(correction, 2000)
  if (!excerpt) return null
  const scope = inferScope(excerpt)
  scope.projects = [cleanId(projectId)]
  if (policy?.riskLevel) scope.risk = [policy.riskLevel]
  const evidence = {
    source_id: `feedback-${sha256(`${agentId}\n${turn}\n${createdAt}`).slice(0, 20)}`,
    message_id: `${cleanId(agentId)}:${turn ?? 'unknown'}`,
    timestamp: createdAt,
    excerpt,
    excerpt_sha256: sha256(excerpt),
    evidence_type: 'direct_correction',
  }
  const dimension = inferDimension(excerpt)
  const kind = inferKind(excerpt, dimension)
  const candidate = {
    id: `candidate-${sha256(`${evidence.source_id}\n${excerpt}`).slice(0, 20)}`,
    kind,
    claim: excerpt,
    dimension,
    scope,
    exclusions: dimension === 'autonomy' ? [...STANDARD_AUTONOMY_EXCLUSIONS] : inferExclusions(excerpt),
    evidence: [evidence],
    confidence: 0,
    confidence_basis: createConfidenceBasis({ evidence: [evidence], scope, explicit: true }),
    status: 'candidate',
    sensitivity: inferSensitivity(excerpt),
    conflicts_with: [],
    confirmed_at: null,
    last_reviewed_at: null,
    expires_at: kind === 'temporary_context' ? new Date(Date.parse(createdAt) + 7 * 86400000).toISOString() : null,
    activation: candidateActivation(scope),
    review: { priority: 0, reasons: [], deferred_until: null },
    revoked_at: null,
    revocation_reason: null,
    supersedes: [],
  }
  refreshCandidateScores(candidate)
  return candidate
}

export function mergeCandidateRecords(leftInput, rightInput) {
  const left = structuredClone(leftInput)
  const right = structuredClone(rightInput)
  left.evidence = mergeEvidence(left.evidence, right.evidence)
  left.scope = mergeScope(left.scope, right.scope)
  left.exclusions = mergeUnique(left.exclusions, right.exclusions)
  left.conflicts_with = mergeUnique(left.conflicts_with, right.conflicts_with)
  left.sensitivity = left.sensitivity === 'sensitive' || right.sensitivity === 'sensitive' ? 'sensitive' : 'normal'
  left.confidence_basis = createConfidenceBasis({
    evidence: left.evidence,
    scope: left.scope,
    explicit: true,
    conflicts: left.conflicts_with.length,
  })
  refreshCandidateScores(left)
  return left
}

export function refreshCandidateScores(candidate) {
  candidate.confidence_basis = candidate.confidence_basis ?? createConfidenceBasis({
    evidence: candidate.evidence,
    scope: candidate.scope,
    explicit: true,
    confirmed: candidate.status === 'user_confirmed',
    conflicts: candidate.conflicts_with?.length ?? 0,
  })
  candidate.confidence_basis.evidence_count = candidate.evidence?.length ?? 0
  candidate.confidence_basis.unique_sources = new Set((candidate.evidence ?? []).map(item => item.source_id)).size
  candidate.confidence_basis.direct_user_statements = candidate.evidence?.length ?? 0
  candidate.confidence_basis.direct_corrections = (candidate.evidence ?? []).filter(item => item.evidence_type === 'direct_correction').length
  candidate.confidence_basis.user_confirmed = candidate.status === 'user_confirmed'
  candidate.confidence_basis.conflict_count = candidate.conflicts_with?.length ?? 0
  candidate.confidence = scoreConfidence(candidate.confidence_basis)
  candidate.activation = candidate.status === 'user_confirmed' ? durableActivation(candidate.scope) : candidateActivation(candidate.scope)
  candidate.review = reviewMetadata(candidate)
  return candidate
}

export function revokeRecord(modelInput, id, reason = 'revoked by user', revokedAt = new Date().toISOString()) {
  const model = upgradeModel(modelInput)
  const record = findModelRecord(model, id)
  if (!record) throw new Error(`Memory record not found: ${id}`)
  record.status = 'revoked'
  record.revoked_at = revokedAt
  record.revocation_reason = cleanText(reason, 1000) || 'revoked by user'
  record.last_reviewed_at = revokedAt
  model.updated_at = revokedAt
  return model
}

export function restoreRecord(modelInput, id, restoredAt = new Date().toISOString()) {
  const model = upgradeModel(modelInput)
  const record = findModelRecord(model, id)
  if (!record) throw new Error(`Memory record not found: ${id}`)
  record.status = 'user_confirmed'
  record.revoked_at = null
  record.revocation_reason = null
  record.last_reviewed_at = restoredAt
  model.updated_at = restoredAt
  return model
}

export function recordProvenance(modelInput, id) {
  const model = upgradeModel(modelInput)
  const record = findModelRecord(model, id)
  if (!record) return null
  return {
    id: record.id,
    kind: record.kind,
    status: record.status,
    claim: record.claim,
    evidence: structuredClone(record.evidence ?? []),
    conflicts_with: structuredClone(record.conflicts_with ?? []),
    confirmed_at: record.confirmed_at ?? null,
    last_reviewed_at: record.last_reviewed_at ?? null,
    revoked_at: record.revoked_at ?? null,
    revocation_reason: record.revocation_reason ?? null,
  }
}

export function sourceImpact(modelInput, sourceId) {
  const model = upgradeModel(modelInput)
  return [...model.preferences, ...model.decision_boundaries]
    .filter(record => (record.evidence ?? []).some(item => item.source_id === sourceId))
    .map(record => ({ id: record.id, kind: record.kind, status: record.status, claim: record.claim }))
}

export function recordsConflict(left, right) {
  return sameConflictGroup(left?.dimension, right?.dimension) && claimsConflict(left?.claim ?? '', right?.claim ?? '')
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

function expandReferencedConversationMessages(messages, depth = 0) {
  if (depth > 3) return messages
  const expanded = []
  for (const message of messages) {
    const reference = parseEmbeddedConversationReference(message.content)
    if (!reference) {
      expanded.push(message)
      continue
    }
    const prior = reference.value?.priorConversation?.conversation
    if (Array.isArray(prior)) {
      const nested = prior.map((entry, index) => normalizeReferencedMessage(entry, message, index)).filter(Boolean)
      expanded.push(...expandReferencedConversationMessages(nested, depth + 1))
    }
    const currentRequest = extractCurrentRequest(message.content, reference.end)
    if (currentRequest) expanded.push({ ...message, content: currentRequest })
  }
  return expanded
}

function parseEmbeddedConversationReference(text) {
  const value = String(text ?? '')
  const matcher = /\{\s*"conversationId"\s*:/g
  for (const match of value.matchAll(matcher)) {
    const json = extractBalancedJson(value, match.index)
    if (!json) continue
    try {
      const parsed = JSON.parse(json.text)
      if (typeof parsed?.conversationId !== 'string' || !Object.hasOwn(parsed, 'priorConversation')) continue
      return { value: parsed, start: match.index, end: json.end }
    } catch {}
  }
  return null
}

function extractBalancedJson(text, start) {
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < text.length; index += 1) {
    const character = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') inString = true
    else if (character === '{') depth += 1
    else if (character === '}') {
      depth -= 1
      if (depth === 0) return { text: text.slice(start, index + 1), end: index + 1 }
    }
  }
  return null
}

function normalizeReferencedMessage(entry, parent, index) {
  const content = Array.isArray(entry?.content)
    ? entry.content.map(part => typeof part === 'string' ? part : part?.text ?? '').filter(Boolean).join('\n')
    : typeof entry?.content === 'string' ? entry.content : entry?.text ?? ''
  if (!content || !['user', 'assistant'].includes(entry?.role)) return null
  return {
    id: `${parent.id}:referenced-${index + 1}`,
    role: entry.role,
    timestamp: normalizeTimestamp(entry.timestamp ?? parent.timestamp),
    content,
  }
}

function extractCurrentRequest(text, referenceEnd) {
  const value = String(text ?? '')
  const marker = /#{1,6}\s*My request\s*:\s*/ig
  let match
  let last = null
  while ((match = marker.exec(value)) !== null) last = match
  if (last) return value.slice(last.index + last[0].length).trim()
  const trailing = value.slice(referenceEnd).replace(/^\s*[-#]+\s*/u, '').trim()
  return trailing || ''
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

function upgradePreference(preference, index, forcedKind = null) {
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
  const scope = Array.isArray(preference.scope)
    ? { domains: preference.scope, actions: ['unspecified'], risk: ['unspecified'], reversibility: ['unspecified'], projects: [] }
    : normalizeScope(preference.scope)
  const status = ['user_confirmed', 'revoked', 'superseded'].includes(preference.status)
    ? preference.status
    : 'user_confirmed'
  const upgraded = {
    id: cleanId(preference.id || `legacy-${index + 1}`),
    kind: forcedKind ?? preference.kind ?? 'interaction_preference',
    claim: String(preference.claim ?? ''),
    dimension: allowedDimension(preference.dimension),
    scope,
    exclusions: Array.isArray(preference.exceptions) ? preference.exceptions : listValue(preference.exclusions),
    evidence,
    confidence: 0,
    confidence_basis: preference.confidence_basis ?? createConfidenceBasis({
      evidence,
      scope,
      explicit: true,
      confirmed: status === 'user_confirmed',
      conflicts: preference.conflicts_with?.length ?? 0,
    }),
    status,
    sensitivity: preference.sensitivity ?? 'normal',
    conflicts_with: listValue(preference.conflicts_with),
    confirmed_at: preference.confirmed_at ?? null,
    last_reviewed_at: preference.last_reviewed_at ?? null,
    expires_at: preference.expires_at ?? null,
    activation: preference.activation ?? durableActivation(scope),
    review: preference.review ?? { priority: 0, reasons: [], deferred_until: null },
    revoked_at: preference.revoked_at ?? null,
    revocation_reason: preference.revocation_reason ?? null,
    supersedes: listValue(preference.supersedes),
  }
  upgraded.confidence = status === 'user_confirmed'
    ? Math.max(clamp(Number(preference.confidence ?? 0), 0, 1), scoreConfidence(upgraded.confidence_basis))
    : scoreConfidence(upgraded.confidence_basis)
  return upgraded
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

function normalizeCurrentModel(modelInput) {
  const model = structuredClone(modelInput)
  model.subject = model.subject ?? { id: 'local-user', label: null }
  model.preferences = (model.preferences ?? []).map((item, index) => upgradePreference(item, index))
  model.decision_boundaries = (model.decision_boundaries ?? []).map((item, index) => upgradePreference(item, index, 'decision_boundary'))
  model.safety_invariants = Array.isArray(model.safety_invariants) ? model.safety_invariants : [...DEFAULT_SAFETY_INVARIANTS]
  return model
}

function createConfidenceBasis({ evidence = [], scope = {}, explicit = false, confirmed = false, conflicts = 0 }) {
  return {
    direct_user_statements: explicit ? evidence.length : 0,
    direct_corrections: evidence.filter(item => item.evidence_type === 'direct_correction').length,
    evidence_count: evidence.length,
    unique_sources: new Set(evidence.map(item => item.source_id)).size,
    scoped: scopeSpecificity(scope),
    user_confirmed: confirmed,
    conflict_count: conflicts,
  }
}

function scoreConfidence(basis = {}) {
  let score = 0.2
  if (basis.direct_user_statements > 0) score += 0.28
  if (basis.direct_corrections > 0) score += 0.12
  score += Math.min(0.18, Math.max(0, Number(basis.evidence_count ?? 0) - 1) * 0.06)
  score += Math.min(0.12, Math.max(0, Number(basis.unique_sources ?? 0) - 1) * 0.06)
  score += Math.min(0.08, Number(basis.scoped ?? 0) * 0.02)
  if (basis.user_confirmed) score += 0.22
  score -= Math.min(0.35, Number(basis.conflict_count ?? 0) * 0.18)
  return Number(clamp(score, 0.05, 0.99).toFixed(2))
}

function scopeSpecificity(scope = {}) {
  const normalized = normalizeScope(scope)
  return ['domains', 'actions', 'risk', 'reversibility', 'projects']
    .reduce((count, key) => count + normalized[key].filter(value => value !== 'unspecified').length, 0)
}

function candidateActivation(scope = {}) {
  const normalized = normalizeScope(scope)
  return {
    session: true,
    project: normalized.projects.length > 0,
    cross_project: false,
    high_risk_authority: false,
  }
}

function durableActivation(scope = {}) {
  const normalized = normalizeScope(scope)
  return { session: true, project: true, cross_project: normalized.projects.length === 0, high_risk_authority: false }
}

function reviewMetadata(candidate) {
  const reasons = []
  let priority = 0
  const evidenceCount = candidate.evidence?.length ?? 0
  if (candidate.evidence?.some(item => item.evidence_type === 'direct_correction')) {
    priority += 35
    reasons.push('direct_user_correction')
  }
  if (evidenceCount > 1) {
    priority += Math.min(25, (evidenceCount - 1) * 10)
    reasons.push('repeated_evidence')
  }
  if (candidate.conflicts_with?.length) {
    priority += 30
    reasons.push('conflict_requires_review')
  }
  if (candidate.kind === 'decision_boundary') {
    priority += 20
    reasons.push('decision_boundary')
  }
  if (candidate.sensitivity === 'sensitive') {
    priority += 15
    reasons.push('sensitive')
  }
  if ((candidate.scope?.projects ?? []).length) {
    priority += 5
    reasons.push('project_scoped')
  }
  return {
    priority: Math.min(100, priority),
    reasons,
    deferred_until: candidate.review?.deferred_until ?? null,
  }
}

function validateRecords(records, label, errors) {
  for (const [index, record] of (records ?? []).entries()) {
    if (!record.id) errors.push(`${label}[${index}].id is required`)
    if (!record.claim) errors.push(`${label}[${index}].claim is required`)
    if (!['user_confirmed', 'revoked', 'superseded'].includes(record.status)) errors.push(`${label}[${index}] has invalid status`)
    if (!Array.isArray(record.evidence) || !record.evidence.length) errors.push(`${label}[${index}].evidence is required`)
    if (label === 'decision_boundaries' && record.kind !== 'decision_boundary') errors.push(`${label}[${index}] must have kind decision_boundary`)
  }
}

function findModelRecord(model, id) {
  return [...(model.preferences ?? []), ...(model.decision_boundaries ?? [])].find(record => record.id === id)
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
