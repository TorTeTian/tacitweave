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
  calibrationMode: Schema.union(['always', 'adaptive', 'off']).default('adaptive'),
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
  const store = new MemoryStore(config.memoryDir)
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

  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name === 'tacitweave_calibrate' || exec.name === 'tacitweave_inspect') return next()
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
      const policyFile = store.savePolicy({ agentId: exec.agent.id, turn: state.turn, policy, outcome })
      return {
        accepted,
        status: outcome.status,
        user_correction: outcome.correction || null,
        policy_file: policyFile,
        instruction: outcome.status === 'adjusted'
          ? 'Continue only after incorporating the user correction into the working policy.'
          : outcome.status === 'skipped'
            ? 'Ignore personalization for this turn; preserve universal safety boundaries.'
            : accepted ? 'Proceed under this calibrated interaction policy.' : 'Do not proceed; ask the user what to change.',
      }
    },
  })
}

function policyInstructions(mode) {
  return `## TacitWeave personal interaction policy\n\nBefore substantive side-effecting work, distinguish descriptive memory from the prescriptive policy for the current task. The runtime Personal Model follows WeaveSpec: use only user_confirmed, unexpired preferences and cite applicable preference IDs in the rationale. Candidate, rejected, expired, or unsupported claims never authorize behavior. Infer only scoped preferences supported by the provided memory. Never generalize a low-risk autonomy preference into destructive, irreversible, financial, privacy-sensitive, publishing, production, or external-communication actions.\n\nFor each new user task, compile: task summary, action mode (act/ask/propose/explain_then_act), assumptions, autonomous actions, user-reserved decisions, risk, confidence, and rationale. Call tacitweave_calibrate before gated tools. Calibration mode is ${mode}. If the user corrects the policy, the correction outranks inferred memory for this turn. Use tacitweave_inspect when the user asks to see the files or when memory provenance is unclear.`
}

export default apply
