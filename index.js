import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { MemoryStore } from './src/store.js'
import {
  interpretCalibrationAnswer,
  isGatedTool,
  normalizePolicy,
  renderCalibrationQuestion,
  shouldCalibrate,
} from './src/core.js'

export const name = 'tacitweave'
export const inject = ['systemPrompt', 'tools', 'userQuestions']

export const Config = Schema.object({
  memoryDir: Schema.string().default('.personal-model'),
  projectId: Schema.string().default('current-project'),
  calibrationMode: Schema.union(['always', 'adaptive', 'off']).default('adaptive'),
  memoryReviewMode: Schema.union(['selective', 'off']).default('selective'),
  maxMemoryChars: Schema.number().default(12000),
  language: Schema.union(['zh-CN', 'en']).default('zh-CN'),
  gatedTools: Schema.array(Schema.string()).default([
    'bash', 'pwsh', 'write', 'edit', 'str_replace_editor',
    'terminal_open', 'terminal_send', 'terminal_signal', 'terminal_close',
    'cordis_define', 'cordis_run', 'cordis_stop', 'cordis_undefine',
    'schedule_create', 'schedule_delete', 'create_goal', 'update_goal',
    'todo_write', 'subagent', 'subagent_fork', 'workflow', 'ralph',
  ]),
})

export function apply(ctx, config) {
  const store = new MemoryStore(config.memoryDir, { projectId: config.projectId })
  const turns = new Map()

  ctx.systemPrompt.section({
    name: 'personal-model:policy-compiler',
    order: 25,
    text: policyInstructions(config.calibrationMode),
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
  ctx.tools.register(createCalibrationTool(ctx, store, turns, config.calibrationMode))
  ctx.tools.register(createMemoryReviewTool(ctx, store, config.memoryReviewMode))

  ctx.on('tools/pre-execute', async (exec, next) => {
    if (['tacitweave_calibrate', 'tacitweave_inspect', 'tacitweave_review_memory'].includes(exec.name)) return next()
    if (!isGatedTool(exec.name, config.gatedTools)) return next()
    if (!exec.agent) return { kind: 'deny', reason: 'Personal Model gate requires an owning agent.' }
    const state = turns.get(String(exec.agent.id))
    if (config.calibrationMode === 'off' || state?.calibrated) return next()
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

function createCalibrationTool(ctx, store, turns, mode) {
  return defineTool({
    name: 'tacitweave_calibrate',
    description: 'Compile and present the interaction policy for this task. This pauses for user confirmation or correction before side-effecting work.',
    parameters: {
      task_summary: { type: 'string', required: true, description: 'One concise sentence describing the current task.' },
      action_mode: { type: 'string', required: true, enum: ['act', 'ask', 'propose', 'explain_then_act'] },
      assumptions: { type: 'array', required: true, items: { type: 'string' } },
      autonomous_actions: { type: 'array', required: true, items: { type: 'string' } },
      reserved_decisions: { type: 'array', required: true, items: { type: 'string' } },
      risk_level: { type: 'string', required: true, enum: ['low', 'medium', 'high', 'critical'] },
      confidence: { type: 'number', required: true, description: 'Confidence from 0 to 1.' },
      rationale: { type: 'string', required: true, description: 'Why the memory and current context imply this policy.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      if (!exec.agent) throw new Error('tacitweave_calibrate requires an owning agent')
      const policy = normalizePolicy(args)
      let outcome = { status: 'auto_approved', correction: '' }
      if (shouldCalibrate(policy, mode)) {
        const response = await ctx.userQuestions.ask({
          questions: [{
            id: 'interaction-policy',
            header: '协作方式校准',
            question: renderCalibrationQuestion(policy),
            options: [
              { label: '准确，继续', description: '按当前协作策略继续执行。' },
              { label: '修改', description: '输入本轮需要调整的协作边界。' },
              { label: '跳过个性化', description: '本轮只使用通用安全边界。' },
            ],
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
      return {
        accepted,
        status: outcome.status,
        user_correction: outcome.correction || null,
        policy_file: saved.policyFile,
        memory_candidate: saved.memoryCandidate,
        instruction: outcome.status === 'adjusted'
          ? 'Continue only after incorporating the user correction into the working policy.'
          : outcome.status === 'skipped'
            ? 'Ignore personalization for this turn; preserve universal safety boundaries.'
            : accepted ? 'Proceed under this calibrated interaction policy.' : 'Do not proceed; ask the user what to change.',
      }
    },
  })
}

function createMemoryReviewTool(ctx, store, mode) {
  return defineTool({
    name: 'tacitweave_review_memory',
    description: 'Review up to two high-priority local memory candidates. Use selectively after the task, never as a prerequisite for ordinary work.',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(_args, exec) {
      if (mode === 'off') return { reviewed: 0, status: 'disabled' }
      if (!exec.agent) throw new Error('tacitweave_review_memory requires an owning agent')
      const queue = store.reviewQueue(2)
      if (!queue.length) return { reviewed: 0, status: 'empty' }
      const response = await ctx.userQuestions.ask({
        questions: queue.map(candidate => ({
          id: `memory:${candidate.id}`,
          header: '长期记忆审阅',
          question: renderMemoryCandidate(candidate),
          options: [
            { label: '接受为长期记忆', description: '提升为确认记忆，但不扩大原有项目范围或安全边界。' },
            { label: '拒绝', description: '保留审计记录，但不让它影响后续行为。' },
            { label: '稍后', description: '七天后再进入优先审阅队列。' },
          ],
        })),
        agent: exec.agent,
        signal: exec.signal,
      })
      const outcomes = queue.map((candidate, index) => {
        const answer = response.answers[index] ?? {}
        const selected = new Set(answer.selected ?? [])
        const custom = String(answer.custom ?? '').trim()
        if (custom || selected.has('接受为长期记忆')) return store.applyReview(candidate.id, 'accept', { claim: custom || undefined })
        if (selected.has('拒绝')) return store.applyReview(candidate.id, 'reject')
        return store.applyReview(candidate.id, 'defer')
      })
      return { reviewed: outcomes.length, outcomes }
    },
  })
}

function renderMemoryCandidate(candidate) {
  const basis = candidate.confidence_basis ?? {}
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

function policyInstructions(mode) {
  return `## TacitWeave personal interaction policy\n\nBefore substantive side-effecting work, distinguish descriptive memory from the prescriptive policy for the current task. Apply this order: universal safety and current instructions; confirmed decision boundaries; confirmed scoped preferences; then tentative same-project candidates. Cite applicable IDs in the rationale. Revoked, superseded, rejected, expired, conflicted, or unsupported claims never affect behavior. Tentative candidates may only help interpret low-risk reversible work in their own project; they never authorize destructive, irreversible, financial, privacy-sensitive, publishing, production, medical, legal, or external actions. If equally specific confirmed records conflict, ask instead of choosing silently.\n\nFor each new user task, compile: task summary, action mode (act/ask/propose/explain_then_act), assumptions, autonomous actions, user-reserved decisions, risk, confidence, and rationale. Call tacitweave_calibrate before gated tools. Calibration mode is ${mode}. A direct correction becomes a local, project-scoped candidate immediately, while the correction itself outranks older memory for this turn. It becomes durable only after review. Use tacitweave_inspect when the user asks to see files or provenance. After completing a task, call tacitweave_review_memory at most once and only when memory_review_status recommends review or the user asks; it reviews no more than two candidates and is never required to finish the task.`
}

export default apply
