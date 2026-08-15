const VALID_MODES = new Set(['act', 'ask', 'propose', 'explain_then_act'])
const VALID_RISKS = new Set(['low', 'medium', 'high', 'critical'])
const VALID_LANGUAGES = new Set(['zh-CN', 'en'])

export function normalizePolicy(input) {
  const policy = {
    taskSummary: cleanText(input.task_summary, 500),
    actionMode: VALID_MODES.has(input.action_mode) ? input.action_mode : 'ask',
    assumptions: cleanStringArray(input.assumptions, 12, 300),
    autonomousActions: cleanStringArray(input.autonomous_actions, 12, 300),
    reservedDecisions: cleanStringArray(input.reserved_decisions, 12, 300),
    riskLevel: VALID_RISKS.has(input.risk_level) ? input.risk_level : 'medium',
    confidence: clamp(Number(input.confidence), 0, 1),
    rationale: cleanText(input.rationale, 1000),
    activatedMemoryIds: cleanStringArray(input.activated_memory_ids, 12, 160),
    displayLanguage: VALID_LANGUAGES.has(input.display_language) ? input.display_language : 'zh-CN',
  }
  if (!policy.taskSummary) throw new Error('task_summary must not be empty')
  return policy
}

export function shouldCalibrate(policy, mode = 'adaptive') {
  if (mode === 'always') return true
  if (mode === 'off') return false
  return policy.actionMode !== 'act'
    || policy.riskLevel === 'high'
    || policy.riskLevel === 'critical'
    || policy.confidence < 0.8
    || policy.reservedDecisions.length > 0
}

export function isGatedTool(name, configuredNames) {
  return new Set(configuredNames).has(name)
}

export function renderCalibrationQuestion(policy, language = policy.displayLanguage ?? 'zh-CN') {
  if (language === 'en') return renderEnglishCalibrationQuestion(policy)
  const lines = [
    `当前任务：${policy.taskSummary}`,
    `建议协作方式：${translateMode(policy.actionMode, language)}`,
    `风险等级：${translateRisk(policy.riskLevel, language)}`,
    `判断置信度：${policy.confidence.toFixed(2)}`,
  ]
  if (policy.assumptions.length) lines.push(`关键假设：${policy.assumptions.join('；')}`)
  if (policy.autonomousActions.length) lines.push(`AI 可自主处理：${policy.autonomousActions.join('；')}`)
  if (policy.reservedDecisions.length) lines.push(`保留给用户：${policy.reservedDecisions.join('；')}`)
  if (policy.rationale) lines.push(`理由：${policy.rationale}`)
  if (policy.activatedMemoryIds.length) lines.push(`拟启用记忆：${policy.activatedMemoryIds.join('、')}`)
  lines.push('这个判断是否准确？如需修改，请选择“修改”并输入修正。')
  return lines.join('\n')
}

export function interpretCalibrationAnswer(answer) {
  const selected = new Set(answer?.selected ?? [])
  const custom = cleanText(answer?.custom, 2000)
  if (custom || selected.has('修改') || selected.has('Modify')) {
    return { status: 'adjusted', correction: custom || (selected.has('Modify') ? 'User requested a modification but provided no text.' : '用户要求修改，但未提供文字说明。') }
  }
  if (selected.has('跳过个性化') || selected.has('Ignore personalization')) return { status: 'skipped', correction: '' }
  if (selected.has('准确，继续') || selected.has('Accurate, continue')) return { status: 'approved', correction: '' }
  return { status: 'rejected', correction: custom }
}

function renderEnglishCalibrationQuestion(policy) {
  const lines = [
    `Current task: ${policy.taskSummary}`,
    `Suggested collaboration mode: ${translateMode(policy.actionMode, 'en')}`,
    `Risk level: ${translateRisk(policy.riskLevel, 'en')}`,
    `Confidence: ${policy.confidence.toFixed(2)}`,
  ]
  if (policy.assumptions.length) lines.push(`Key assumptions: ${policy.assumptions.join('; ')}`)
  if (policy.autonomousActions.length) lines.push(`AI may handle autonomously: ${policy.autonomousActions.join('; ')}`)
  if (policy.reservedDecisions.length) lines.push(`Reserved for the user: ${policy.reservedDecisions.join('; ')}`)
  if (policy.rationale) lines.push(`Rationale: ${policy.rationale}`)
  if (policy.activatedMemoryIds.length) lines.push(`Memories to activate: ${policy.activatedMemoryIds.join(', ')}`)
  lines.push('Is this accurate? To change it, choose “Modify” and enter the correction.')
  return lines.join('\n')
}

function translateMode(mode, language) {
  if (language === 'en') return ({ act: 'act', ask: 'ask first', propose: 'propose first', explain_then_act: 'explain, then act' })[mode] ?? mode
  return ({ act: '直接执行', ask: '先询问', propose: '先提出方案', explain_then_act: '解释后执行' })[mode] ?? mode
}

function translateRisk(risk, language) {
  if (language === 'en') return risk
  return ({ low: '低', medium: '中', high: '高', critical: '严重' })[risk] ?? risk
}

export function sanitizeId(value) {
  return String(value ?? 'unknown').replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 120)
}

function cleanText(value, maxLength) {
  return String(value ?? '').trim().slice(0, maxLength)
}

function cleanStringArray(value, maxItems, maxLength) {
  if (!Array.isArray(value)) return []
  return value.slice(0, maxItems).map(item => cleanText(item, maxLength)).filter(Boolean)
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}
