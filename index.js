import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { MemoryStore } from './src/store.js'
import { resolveMemoryDirectory } from './src/paths.js'
import { registerMemoryDashboardApi } from './src/web-api.js'
import {
  interpretCalibrationAnswer,
  isGatedTool,
  normalizePolicy,
  renderCalibrationQuestion,
  shouldCalibrate,
} from './src/core.js'

export const name = 'tacitweave'
export const inject = ['systemPrompt', 'tools', 'userQuestions', 'webServer']

export const Config = Schema.object({
  memoryDir: Schema.string().default('.personal-model'),
  projectId: Schema.string().default('current-project'),
  calibrationMode: Schema.union(['always', 'adaptive', 'off']).default('adaptive'),
  memoryReviewMode: Schema.union(['selective', 'off']).default('selective'),
  maxMemoryChars: Schema.number().default(12000),
  language: Schema.union(['auto', 'zh-CN', 'en']).default('auto'),
  gatedTools: Schema.array(Schema.string()).default([
    'bash', 'pwsh', 'write', 'edit', 'str_replace_editor',
    'terminal_open', 'terminal_send', 'terminal_signal', 'terminal_close',
    'cordis_define', 'cordis_run', 'cordis_stop', 'cordis_undefine',
    'schedule_create', 'schedule_delete', 'create_goal', 'update_goal',
    'todo_write', 'subagent', 'subagent_fork', 'workflow', 'ralph',
  ]),
})

export function apply(ctx, config) {
  const memoryResolution = resolveMemoryDirectory(config.memoryDir)
  const store = new MemoryStore(memoryResolution.path, { projectId: config.projectId, memoryResolution })
  const turns = new Map()

  ctx.effect(() => registerMemoryDashboardApi(ctx, store), 'tacitweave: local memory dashboard api')

  ctx.systemPrompt.section({
    name: 'personal-model:policy-compiler',
    order: 25,
    text: () => policyInstructions(config.calibrationMode, config.language, store.readControls()),
  })
  ctx.systemPrompt.context({
    name: 'personal-model:memory',
    order: 25,
    text: () => store.renderContext(config.maxMemoryChars),
  })

  ctx.on('agent/pre-step', async ({ agent, turn, step }, next) => {
    const key = String(agent.id)
    const previous = turns.get(key)
    if (!previous || previous.turn !== turn) turns.set(key, { turn, calibrated: false, step })
    else previous.step = step
    return next()
  })

  ctx.tools.register(createInspectTool(store))
  ctx.tools.register(createCalibrationTool(ctx, store, turns, config.calibrationMode, config.language))
  ctx.tools.register(createMemoryReviewTool(ctx, store, config.memoryReviewMode, config.language))

  ctx.on('tools/pre-execute', async (exec, next) => {
    if (['tacitweave_calibrate', 'tacitweave_inspect', 'tacitweave_review_memory'].includes(exec.name)) return next()
    if (!isGatedTool(exec.name, config.gatedTools)) return next()
    if (!exec.agent) return { kind: 'deny', reason: 'Personal Model gate requires an owning agent.' }
    const state = turns.get(String(exec.agent.id))
    if (!store.readControls().enabled || config.calibrationMode === 'off' || state?.calibrated) return next()
    return {
      kind: 'deny',
      reason: `TacitWeave gate: before using side-effect tool "${exec.name}", compile the current interaction policy and call tacitweave_calibrate.`,
    }
  })
}

function createInspectTool(store) {
  return defineTool({
    name: 'tacitweave_inspect',
    description: 'Show the user-reviewable Personal Model memory files and the currently loaded model.',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute() { return store.inspect() },
  })
}

function createCalibrationTool(ctx, store, turns, mode, configuredLanguage) {
  return defineTool({
    name: 'tacitweave_calibrate',
    description: 'Compile and present the interaction policy for this task. This pauses for user confirmation or correction before side-effecting work.',
    parameters: {
      display_language: { type: 'string', required: true, enum: ['zh-CN', 'en'], description: 'Language of the user\'s latest substantive message. All user-visible free-text fields must already be written in this language.' },
      task_summary: { type: 'string', required: true, description: 'One concise sentence describing the current task.' },
      action_mode: { type: 'string', required: true, enum: ['act', 'ask', 'propose', 'explain_then_act'] },
      assumptions: { type: 'array', required: true, items: { type: 'string' } },
      autonomous_actions: { type: 'array', required: true, items: { type: 'string' } },
      reserved_decisions: { type: 'array', required: true, items: { type: 'string' } },
      risk_level: { type: 'string', required: true, enum: ['low', 'medium', 'high', 'critical'] },
      confidence: { type: 'number', required: true, description: 'Confidence from 0 to 1.' },
      rationale: { type: 'string', required: true, description: 'Why the memory and current context imply this policy.' },
      activated_memory_ids: { type: 'array', required: false, items: { type: 'string' }, description: 'IDs of stored memories that are materially relevant to this task. Omit unrelated memories.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      if (!exec.agent) throw new Error('tacitweave_calibrate requires an owning agent')
      const policy = normalizePolicy(args)
      const displayLanguage = effectiveLanguage(policy.displayLanguage, configuredLanguage)
      policy.displayLanguage = displayLanguage
      const copy = calibrationCopy(displayLanguage)
      const controls = store.readControls()
      const activationRecords = store.activationRecords(policy.activatedMemoryIds)
      let outcome = { status: 'auto_approved', correction: '' }
      if (controls.enabled && controls.ask_before_activation
        && (activationRecords.length > 0 || shouldCalibrate(policy, mode))) {
        const response = await ctx.userQuestions.ask({
          questions: [{
            id: 'interaction-policy',
            header: copy.header,
            question: [
              renderCalibrationQuestion(policy, displayLanguage),
              renderActivationCandidates(activationRecords, displayLanguage),
            ].filter(Boolean).join('\n\n'),
            options: copy.options,
          }],
          agent: exec.agent,
          signal: exec.signal,
        })
        outcome = interpretCalibrationAnswer(response.answers[0])
      }
      const state = turns.get(String(exec.agent.id)) ?? { turn: null, calibrated: false }
      const accepted = outcome.status !== 'rejected'
      state.calibrated = accepted
      turns.set(String(exec.agent.id), state)
      const saved = store.savePolicy({ agentId: exec.agent.id, turn: state.turn, policy, outcome })
      const activationNotice = accepted && outcome.status !== 'skipped' && controls.announce_activation
        ? renderActivationNotice(activationRecords, displayLanguage)
        : null
      return {
        accepted,
        status: outcome.status,
        user_correction: outcome.correction || null,
        policy_file: saved.policyFile,
        memory_candidate: saved.memoryCandidate,
        activation_notice: activationNotice,
        instruction: localizedInstruction(outcome.status, accepted, displayLanguage),
      }
    },
  })
}

function createMemoryReviewTool(ctx, store, mode, configuredLanguage) {
  return defineTool({
    name: 'tacitweave_review_memory',
    description: 'Review up to two high-priority local memory candidates. Use selectively after the task, never as a prerequisite for ordinary work.',
    parameters: {
      display_language: { type: 'string', required: true, enum: ['zh-CN', 'en'], description: 'Language of the user\'s latest substantive message.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      if (mode === 'off' || !store.readControls().enabled) return { reviewed: 0, status: 'disabled' }
      if (!exec.agent) throw new Error('tacitweave_review_memory requires an owning agent')
      const queue = store.reviewQueue(2)
      if (!queue.length) return { reviewed: 0, status: 'empty' }
      const displayLanguage = effectiveLanguage(args.display_language, configuredLanguage)
      const copy = memoryReviewCopy(displayLanguage)
      const response = await ctx.userQuestions.ask({
        questions: queue.map(candidate => ({
          id: `memory:${candidate.id}`,
          header: copy.header,
          question: renderMemoryCandidate(candidate, displayLanguage),
          options: copy.options,
        })),
        agent: exec.agent,
        signal: exec.signal,
      })
      const outcomes = queue.map((candidate, index) => {
        const answer = response.answers[index] ?? {}
        const selected = new Set(answer.selected ?? [])
        const custom = String(answer.custom ?? '').trim()
        if (custom || selected.has('接受为长期记忆') || selected.has('Accept as long-term memory')) return store.applyReview(candidate.id, 'accept', { claim: custom || undefined })
        if (selected.has('拒绝') || selected.has('Reject')) return store.applyReview(candidate.id, 'reject')
        return store.applyReview(candidate.id, 'defer')
      })
      return { reviewed: outcomes.length, outcomes }
    },
  })
}

function renderMemoryCandidate(candidate, language) {
  const basis = candidate.confidence_basis ?? {}
  if (language === 'en') {
    return [
      `Memory candidate: ${candidate.claim}`,
      `Kind: ${candidate.kind}; confidence: ${candidate.confidence}`,
      `Scope: ${JSON.stringify(candidate.scope)}`,
      candidate.exclusions?.length ? `Explicit exclusions: ${candidate.exclusions.join(', ')}` : null,
      candidate.conflicts_with?.length ? `Conflicts: ${candidate.conflicts_with.join(', ')}` : null,
      `Evidence: ${basis.evidence_count ?? 0} item(s) from ${basis.unique_sources ?? 0} source(s)`,
      'You may enter a corrected statement directly.',
    ].filter(Boolean).join('\n')
  }
  return [
    `候选记忆：${candidate.claim}`,
    `类型：${candidate.kind}；置信度：${candidate.confidence}`,
    `范围：${JSON.stringify(candidate.scope)}`,
    candidate.exclusions?.length ? `明确排除：${candidate.exclusions.join('、')}` : null,
    candidate.conflicts_with?.length ? `冲突：${candidate.conflicts_with.join('、')}` : null,
    `依据：${basis.evidence_count ?? 0} 条证据，${basis.unique_sources ?? 0} 个来源`,
    '可直接输入修改后的准确表述。',
  ].filter(Boolean).join('\n')
}

function policyInstructions(mode, languageMode, controls) {
  if (!controls.enabled) return '## TacitWeave\n\nThe user disabled TacitWeave memory personalization. Do not activate stored memories or call TacitWeave calibration/review tools unless the user explicitly asks to inspect or re-enable memory.'
  const activationMode = controls.ask_before_activation
    ? 'Ask for confirmation through tacitweave_calibrate before applying selected memory when calibration is required.'
    : 'Select relevant memory autonomously. Pass every materially used ID in activated_memory_ids; do not pass memories merely because they are available.'
  return `## TacitWeave personal interaction policy\n\nBefore substantive side-effecting work, distinguish descriptive memory from the prescriptive policy for the current task. Apply this order: universal safety and current instructions; confirmed decision boundaries; confirmed scoped preferences; then tentative same-project candidates. Cite applicable IDs in the rationale. Revoked, superseded, rejected, expired, disabled, below-threshold, conflicted, or unsupported claims never affect behavior. Tentative candidates may only help interpret low-risk reversible work in their own project; they never authorize destructive, irreversible, financial, privacy-sensitive, publishing, production, medical, legal, or external actions. If equally specific confirmed records conflict, ask instead of choosing silently. Activation threshold is ${controls.activation_threshold.toFixed(2)}. ${activationMode}\n\nFor each new user task, compile: task summary, action mode (act/ask/propose/explain_then_act), assumptions, autonomous actions, user-reserved decisions, risk, confidence, rationale, and activated_memory_ids. Call tacitweave_calibrate before gated tools. Calibration mode is ${mode}. Display language mode is ${languageMode}. Set display_language to the language of the user's latest substantive message. Every user-visible free-text argument—including task_summary, assumptions, autonomous_actions, reserved_decisions, and rationale—must already use that language. Never show an English internal plan inside a Chinese calibration dialog, or vice versa. If the tool returns activation_notice, output that sentence verbatim before the substantive response. Apply the same language rule to tacitweave_review_memory. A direct correction becomes a local, project-scoped candidate immediately, while the correction itself outranks older memory for this turn. It becomes durable only after review. Use tacitweave_inspect when the user asks to see files or provenance. After completing a task, call tacitweave_review_memory at most once and only when memory_review_status recommends review or the user asks; it reviews no more than two candidates and is never required to finish the task.`
}

function renderActivationNotice(records, language) {
  if (!records.length) return null
  const primary = records[0]
  const more = records.length - 1
  const confidence = Number(primary.confidence ?? 0).toFixed(2)
  if (language === 'en') {
    return `Based on prior conversations, I am applying this memory: ${primary.claim} (confidence: ${confidence}${more ? `; plus ${more} other relevant memory item(s)` : ''}).`
  }
  return `根据过往交流经验，本轮启用记忆：“${primary.claim}”（可信度：${confidence}${more ? `；另有 ${more} 条相关记忆` : ''}）。`
}

function renderActivationCandidates(records, language) {
  if (!records.length) return null
  if (language === 'en') {
    return ['Memories proposed for this task:', ...records.map(item => `- ${item.claim} (confidence: ${Number(item.confidence ?? 0).toFixed(2)})`)].join('\n')
  }
  return ['本轮拟启用的记忆：', ...records.map(item => `- ${item.claim}（可信度：${Number(item.confidence ?? 0).toFixed(2)}）`)].join('\n')
}

function effectiveLanguage(requested, configured) {
  if (configured === 'zh-CN' || configured === 'en') return configured
  return requested === 'en' ? 'en' : 'zh-CN'
}

function calibrationCopy(language) {
  if (language === 'en') return {
    header: 'Collaboration check',
    options: [
      { label: 'Accurate, continue', description: 'Continue under the displayed collaboration policy.' },
      { label: 'Modify', description: 'Enter the collaboration boundary to change for this task.' },
      { label: 'Ignore personalization', description: 'Use only general safety boundaries for this task.' },
    ],
  }
  return {
    header: '协作方式校准',
    options: [
      { label: '准确，继续', description: '按当前协作策略继续执行。' },
      { label: '修改', description: '输入本轮需要调整的协作边界。' },
      { label: '跳过个性化', description: '本轮只使用通用安全边界。' },
    ],
  }
}

function memoryReviewCopy(language) {
  if (language === 'en') return {
    header: 'Memory review',
    options: [
      { label: 'Accept as long-term memory', description: 'Confirm this memory without widening its project scope or safety boundaries.' },
      { label: 'Reject', description: 'Keep the audit record but prevent behavioral use.' },
      { label: 'Later', description: 'Return it to the priority review queue in seven days.' },
    ],
  }
  return {
    header: '长期记忆审阅',
    options: [
      { label: '接受为长期记忆', description: '提升为确认记忆，但不扩大原有项目范围或安全边界。' },
      { label: '拒绝', description: '保留审计记录，但不让它影响后续行为。' },
      { label: '稍后', description: '七天后再进入优先审阅队列。' },
    ],
  }
}

function localizedInstruction(status, accepted, language) {
  if (language === 'en') {
    if (status === 'adjusted') return 'Continue only after incorporating the user correction into the working policy.'
    if (status === 'skipped') return 'Ignore personalization for this turn; preserve universal safety boundaries.'
    return accepted ? 'Proceed under this calibrated interaction policy.' : 'Do not proceed; ask the user what to change.'
  }
  if (status === 'adjusted') return '将用户修正纳入本轮协作策略后再继续。'
  if (status === 'skipped') return '本轮忽略个性化，只保留通用安全边界。'
  return accepted ? '按照已校准的协作策略继续。' : '不要继续；询问用户需要修改什么。'
}

export default apply
