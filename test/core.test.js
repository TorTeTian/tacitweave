import test from 'node:test'
import assert from 'node:assert/strict'
import {
  interpretCalibrationAnswer,
  isGatedTool,
  normalizePolicy,
  renderCalibrationQuestion,
  shouldCalibrate,
} from '../src/core.js'

const lowRiskPolicy = normalizePolicy({
  task_summary: '整理局部变量名',
  action_mode: 'act',
  assumptions: [],
  autonomous_actions: ['重命名变量'],
  reserved_decisions: [],
  risk_level: 'low',
  confidence: 0.95,
  rationale: '低风险且可逆',
})

test('adaptive mode avoids needless calibration for confident low-risk act policy', () => {
  assert.equal(shouldCalibrate(lowRiskPolicy, 'adaptive'), false)
  assert.equal(shouldCalibrate(lowRiskPolicy, 'always'), true)
})

test('adaptive mode calibrates high risk and reserved decisions', () => {
  assert.equal(shouldCalibrate({ ...lowRiskPolicy, riskLevel: 'high' }, 'adaptive'), true)
  assert.equal(shouldCalibrate({ ...lowRiskPolicy, reservedDecisions: ['是否删除'] }, 'adaptive'), true)
})

test('calibration answers preserve user correction', () => {
  assert.deepEqual(
    interpretCalibrationAnswer({ selected: ['修改'], custom: '先给我看候选文件。' }),
    { status: 'adjusted', correction: '先给我看候选文件。' },
  )
})

test('configured gated tools are exact matches', () => {
  assert.equal(isGatedTool('write', ['write', 'bash']), true)
  assert.equal(isGatedTool('read', ['write', 'bash']), false)
})

test('question renders policy boundaries', () => {
  const text = renderCalibrationQuestion({ ...lowRiskPolicy, reservedDecisions: ['最终方法'] })
  assert.match(text, /保留给用户：最终方法/)
  assert.match(text, /判断置信度：0\.95/)
})
