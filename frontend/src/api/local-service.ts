import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import {
  APPROVED_STATUS,
  AUDIT_KEY,
  CHANGE_CATEGORIES,
  CHANGE_KEY,
  PENDING_EVALUATION_STATUS,
  RETURNED_STATUS,
  categoryOf,
  earliestEffectiveDate,
  effectiveDateOf,
  evaluationOf,
  isEvaluated,
  isStageStatus,
  isSupplierChange,
  isValidDate,
  labelOf,
  meetsLeadDate,
  splitStages,
  stageOf,
  stageStatus,
  todayText,
  trackOf,
} from '@/data/changecontrol'
import type {
  ActionResult,
  BatchItemResult,
  BatchResult,
  EntryRow,
  ModuleMeta,
  OverviewResult,
  PageResult,
} from '@/data/types'
import type { ChangeRow, EvaluationInput, RiskRow, TrackItem } from '@/data/changecontrol'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  // 变更控制按工序会签，通用的「一步跳到目标状态」动作不适用于它，统一引导到专属操作。
  if (key === CHANGE_KEY) {
    return { ok: false, message: '变更控制请使用「提交评估 / 本工序会签 / 整组批准 / 整组退回」等专属操作' }
  }
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

// ---------------------------------------------------------------------------
// 变更控制专属流转：批量评估、按工序串行会签、整组批准/退回、生效日期校验、供应商联动。
// ---------------------------------------------------------------------------

function changeRows(): ChangeRow[] {
  return listRows(CHANGE_KEY) as ChangeRow[]
}

function persistChangeRows(rows: ChangeRow[]): void {
  saveRows(CHANGE_KEY, rows as EntryRow[])
}

function nonEmpty(value: unknown): boolean {
  return String(value ?? '').trim() !== ''
}

function validRiskRows(risks: RiskRow[]): RiskRow[] {
  return risks.filter((risk) => nonEmpty(risk.item) && nonEmpty(risk.control))
}

// 评估前的逐条校验：缺类别/缺风险评估/非法日期/类别与日期冲突，都在这里逐条落账，
// 同一份变更重复评估命中幂等（skipped），不会再算一次。
function evaluateCheck(
  row: ChangeRow,
  input: EvaluationInput,
  evaluatedAt: string,
): { ok: boolean; skip?: boolean; message: string } {
  const status = String(row.status)
  if (status === APPROVED_STATUS) {
    return { ok: false, message: '已批准，不再受理评估' }
  }
  if (status === RETURNED_STATUS) {
    return { ok: false, message: '已退回，需重新登记后再评估' }
  }
  if (isEvaluated(row)) {
    // 同一份变更重复评估只算一次：保留首次评估意见与风险评估表。
    return { ok: false, skip: true, message: '已评估过，重复提交只按一次计算，沿用首次评估意见' }
  }
  if (!nonEmpty(row['变更类别'])) {
    return { ok: false, message: '缺少变更类别，请先补填' }
  }
  const category = categoryOf(row['变更类别'])
  if (!category) {
    return {
      ok: false,
      message: `变更类别无法识别（应为 ${CHANGE_CATEGORIES.join('、')}，可带「-供应商」后缀），请补填`,
    }
  }
  if (!nonEmpty(row['风险评估'])) {
    return { ok: false, message: '缺少风险评估结论，请先补填' }
  }
  if (!nonEmpty(input.opinion)) {
    return { ok: false, message: '评估意见为空，且须附风险评估表' }
  }
  if (validRiskRows(input.risks).length === 0) {
    return { ok: false, message: '评估意见未附风险评估表（至少一行有效风险点与控制措施）' }
  }
  const stages = splitStages(row['涉及工序'])
  if (stages.length === 0) {
    return { ok: false, message: '缺少涉及工序，无法按工序流转审批' }
  }
  // 生效日期是同一份：统一从生效日期字段读取，不存在两处对不上的情况。
  const effectiveDate = effectiveDateOf(row)
  if (!nonEmpty(effectiveDate)) {
    return { ok: false, message: '生效日期未填写，请补填' }
  }
  if (!isValidDate(effectiveDate)) {
    // 非法值（2026-02-30、13 月、写错格式）一律打回重填，不进入评估。
    return { ok: false, message: `生效日期「${effectiveDate}」不是合法日期，请按 YYYY-MM-DD 重填` }
  }
  if (!meetsLeadDate(category, effectiveDate, evaluatedAt)) {
    // 仲裁规则先定：变更类别与生效日期冲突时，以变更类别为准。
    return {
      ok: false,
      message: `生效日期早于「${category}」允许的最早生效日 ${earliestEffectiveDate(
        category,
        evaluatedAt,
      )}（类别与日期冲突以变更类别为准），请调整后重填`,
    }
  }
  return { ok: true, message: '' }
}

// 评估通过即附上评估意见与风险评估表，状态直接进入第一道工序会签（无工序的已在校验中挡回）。
function applyEvaluation(rows: ChangeRow[], index: number, input: EvaluationInput, evaluatedAt: string): void {
  const row = rows[index]
  const stages = splitStages(row['涉及工序'])
  rows[index] = {
    ...row,
    评估意见: input.opinion.trim(),
    风险表: validRiskRows(input.risks),
    评估人: input.evaluator.trim(),
    评估时间: evaluatedAt,
    status: stageStatus(stages[0]),
    pending: true,
    abnormal: false,
  }
}

// 单条评估（页面行内按钮走这里），返回与批量一致的逐条结果，便于复用同一套提示。
export function submitChangeEvaluation(
  id: number,
  input: EvaluationInput,
  evaluatedAt: string = todayText(),
): BatchItemResult {
  const rows = changeRows()
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { id, label: `#${id}`, status: 'blocked', message: '没有找到这条变更申请' }
  }
  const row = rows[index]
  const check = evaluateCheck(row, input, evaluatedAt)
  const label = labelOf(row)
  if (check.skip) {
    return { id, label, status: 'skipped', message: check.message }
  }
  if (!check.ok) {
    return { id, label, status: 'blocked', message: check.message }
  }
  applyEvaluation(rows, index, input, evaluatedAt)
  persistChangeRows(rows)
  return { id, label, status: 'success', message: `评估完成，进入「${rows[index].status}」` }
}

// 批量评估：勾住多条一起提交，逐条给出结果；被挡回的单独列示，其余照常推进。
export function submitChangeEvaluations(
  ids: number[],
  input: EvaluationInput,
  evaluatedAt: string = todayText(),
): BatchResult {
  const rows = changeRows()
  const idSet = new Set(ids)
  const items: BatchItemResult[] = []
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]
    if (!idSet.has(Number(row.id))) {
      continue
    }
    const check = evaluateCheck(row, input, evaluatedAt)
    const label = labelOf(row)
    if (check.skip) {
      items.push({ id: Number(row.id), label, status: 'skipped', message: check.message })
      continue
    }
    if (!check.ok) {
      items.push({ id: Number(row.id), label, status: 'blocked', message: check.message })
      continue
    }
    applyEvaluation(rows, index, input, evaluatedAt)
    items.push({
      id: Number(row.id), label, status: 'success',
      message: `评估完成，进入「${rows[index].status}」`,
    })
  }
  persistChangeRows(rows)
  return summarizeBatch(items)
}

// 一道工序会签通过：只允许从当前工序状态往下走一节；越级（直接批准终态）在这里挡回。
function advanceStage(
  rows: ChangeRow[],
  index: number,
  approver: string,
  opinion: string,
  actedAt: string,
): ActionResult {
  const row = rows[index]
  const status = String(row.status)
  if (!isStageStatus(status)) {
    return {
      ok: false,
      message: `当前状态「${status}」不在任何工序会签环节，不能会签（状态必须一节一节推进）`,
    }
  }
  const stages = splitStages(row['涉及工序'])
  const current = stageOf(status)
  const position = stages.indexOf(current)
  if (position < 0) {
    return { ok: false, message: `状态工序「${current}」与涉及工序不一致，请核对` }
  }
  const track: TrackItem = {
    stage: current,
    approver: approver.trim(),
    approvedAt: actedAt,
    opinion: opinion.trim(),
  }
  const history = trackOf(row)
  const nextTrack = [...history.filter((item) => item.stage !== current), track]
  let nextStatus: string
  let pending: boolean
  if (position + 1 < stages.length) {
    nextStatus = stageStatus(stages[position + 1])
    pending = true
  } else {
    // 全部工序会签齐了才允许落到已批准，同时生成供应商审计待办。
    nextStatus = APPROVED_STATUS
    pending = false
  }
  rows[index] = {
    ...row,
    status: nextStatus,
    pending,
    abnormal: false,
    审批人: approver.trim() || String(row['审批人'] ?? ''),
    工序流转: nextTrack,
  }
  return { ok: true, message: `「${current}」会签通过，当前状态「${nextStatus}」` }
}

// 单条会签批准。
export function approveChangeStage(
  id: number,
  approver: string,
  opinion = '',
  actedAt: string = todayText(),
): BatchItemResult {
  const rows = changeRows()
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { id, label: `#${id}`, status: 'blocked', message: '没有找到这条变更申请' }
  }
  const label = labelOf(rows[index])
  const result = advanceStage(rows, index, approver, opinion, actedAt)
  if (!result.ok) {
    return { id, label, status: 'blocked', message: result.message }
  }
  const approved = rows[index]
  persistChangeRows(rows)
  if (String(approved.status) === APPROVED_STATUS) {
    createSupplierTodoIfNeeded(approved)
  }
  return { id, label, status: 'success', message: result.message }
}

// 整组批准：逐条按当前工序推进会签；不在会签环节的（待评估/评估中/已退回等）挡回，不允许越级。
export function approveChangesAsGroup(
  ids: number[],
  approver: string,
  opinion = '',
  actedAt: string = todayText(),
): BatchResult {
  const rows = changeRows()
  const idSet = new Set(ids)
  const items: BatchItemResult[] = []
  const approvedRows: ChangeRow[] = []
  rows.forEach((row, index) => {
    if (!idSet.has(Number(row.id))) {
      return
    }
    const label = labelOf(row)
    const result = advanceStage(rows, index, approver, opinion, actedAt)
    if (!result.ok) {
      items.push({ id: Number(row.id), label, status: 'blocked', message: result.message })
      return
    }
    if (String(rows[index].status) === APPROVED_STATUS) {
      approvedRows.push(rows[index])
    }
    items.push({ id: Number(row.id), label, status: 'success', message: result.message })
  })
  persistChangeRows(rows)
  approvedRows.forEach(createSupplierTodoIfNeeded)
  return summarizeBatch(items)
}

// 整组退回：评估中或会签中的变更退回后状态落「已退回」并标异常；待评估的还没进入流程，提示补填即可。
function rejectRow(rows: ChangeRow[], index: number, reason: string, actedAt: string): ActionResult {
  const row = rows[index]
  const status = String(row.status)
  if (status === PENDING_EVALUATION_STATUS) {
    return { ok: false, message: '尚未提交评估，请直接在列表补填后再提交' }
  }
  if (status === APPROVED_STATUS || status === RETURNED_STATUS) {
    return { ok: false, message: `当前状态「${status}」，不能退回` }
  }
  rows[index] = {
    ...row,
    status: RETURNED_STATUS,
    pending: false,
    abnormal: true,
    退回原因: reason.trim(),
    退回时间: actedAt,
  }
  return { ok: true, message: '已整组退回，状态「已退回」' }
}

export function rejectChange(id: number, reason: string, actedAt: string = todayText()): BatchItemResult {
  const rows = changeRows()
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { id, label: `#${id}`, status: 'blocked', message: '没有找到这条变更申请' }
  }
  const label = labelOf(rows[index])
  const result = rejectRow(rows, index, reason, actedAt)
  if (!result.ok) {
    return { id, label, status: 'blocked', message: result.message }
  }
  persistChangeRows(rows)
  return { id, label, status: 'success', message: result.message }
}

export function rejectChangesAsGroup(ids: number[], reason: string, actedAt: string = todayText()): BatchResult {
  const rows = changeRows()
  const idSet = new Set(ids)
  const items: BatchItemResult[] = []
  rows.forEach((row, index) => {
    if (!idSet.has(Number(row.id))) {
      return
    }
    const label = labelOf(row)
    const result = rejectRow(rows, index, reason, actedAt)
    items.push({
      id: Number(row.id),
      label,
      status: result.ok ? 'success' : 'blocked',
      message: result.message,
    })
  })
  persistChangeRows(rows)
  return summarizeBatch(items)
}

// 已退回的变更按要求修订后可重新登记：回到待评估，旧评估意见/会签/退回痕迹清空，需要重新评估。
export function reopenChange(id: number): ActionResult {
  const rows = changeRows()
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: '没有找到这条变更申请' }
  }
  const row = rows[index]
  if (String(row.status) !== RETURNED_STATUS) {
    return { ok: false, message: `当前状态「${row.status}」，只有已退回的变更可以重新登记` }
  }
  rows[index] = {
    ...row,
    status: PENDING_EVALUATION_STATUS,
    pending: true,
    abnormal: false,
    评估意见: '',
    评估人: '',
    评估时间: '',
    风险表: [],
    工序流转: [],
    退回原因: '',
    退回时间: '',
  }
  persistChangeRows(rows)
  return { ok: true, message: '已重新登记，状态回到「待评估」，请补填后重新提交评估' }
}

// 打回重填：仅待评估的变更可补填；生效日期当场按同一套规则校验，非法值保存不了。
export function updateChangeDraft(
  id: number,
  patch: { category: string; process: string; risk: string; effectiveDate: string; approver: string },
): ActionResult {
  const rows = changeRows()
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: '没有找到这条变更申请' }
  }
  const row = rows[index]
  if (String(row.status) !== PENDING_EVALUATION_STATUS) {
    return { ok: false, message: `当前状态「${row.status}」，只有待评估的变更可以补填重填` }
  }
  const category = patch.category.trim()
  const parsedCategory = categoryOf(category)
  if (!parsedCategory) {
    return { ok: false, message: `变更类别应为 ${CHANGE_CATEGORIES.join('、')}（可带「-供应商」后缀）` }
  }
  if (splitStages(patch.process).length === 0) {
    return { ok: false, message: '涉及工序不能为空，否则无法按工序流转审批' }
  }
  if (!patch.risk.trim()) {
    return { ok: false, message: '风险评估结论不能为空' }
  }
  const effectiveDate = patch.effectiveDate.trim()
  if (!isValidDate(effectiveDate)) {
    return { ok: false, message: `生效日期「${effectiveDate || '空'}」不是合法日期，请按 YYYY-MM-DD 重填` }
  }
  if (!meetsLeadDate(parsedCategory, effectiveDate)) {
    return {
      ok: false,
      message: `生效日期早于「${parsedCategory}」允许的最早生效日 ${earliestEffectiveDate(
        parsedCategory,
      )}（冲突以变更类别为准），请重填`,
    }
  }
  rows[index] = {
    ...row,
    变更类别: category,
    涉及工序: patch.process.trim(),
    风险评估: patch.risk.trim(),
    生效日期: effectiveDate,
    审批人: patch.approver.trim(),
  }
  persistChangeRows(rows)
  return { ok: true, message: '补填已保存，可重新提交评估' }
}

// 供应商联动：供应商类变更全部工序会签通过（已批准）后，在供应商审计生成一条待办。
// 同一份变更只生成一条（幂等），整组批准里多条供应商变更会分别落账。
function createSupplierTodoIfNeeded(change: ChangeRow): void {
  if (!isSupplierChange(change)) {
    return
  }
  const audits = listRows(AUDIT_KEY)
  const ref = labelOf(change)
  if (audits.some((row) => String(row['来源变更'] ?? '') === ref)) {
    return
  }
  const nextId = audits.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  const supplier = String(change['变更内容'] ?? '').split(/[，。;；\n]/)[0].slice(0, 20) || '待确认供应商'
  const todo: EntryRow = {
    id: nextId,
    status: '待审计',
    pending: true,
    abnormal: false,
    审计编号: `SUPP-CHG-${String(nextId).padStart(4, '0')}`,
    供应商名称: supplier,
    物料类别: String(change['变更类别'] ?? '供应商变更'),
    审计方式: '现场审计',
    缺陷项数: 0,
    审计结论: '',
    整改期限: '',
    审计状态: '待审计',
    来源变更: ref,
  }
  saveRows(AUDIT_KEY, [...audits, todo])
}

// 供应商审计待办列表（供应商审计页面直接读取）。
export function supplierChangeTodos(): EntryRow[] {
  return listRows(AUDIT_KEY).filter((row) => nonEmpty(row['来源变更']))
}

// 取变更的评估记录（详情面板用）。
export function changeEvaluation(id: number) {
  const row = changeRows().find((item) => Number(item.id) === id)
  return row ? evaluationOf(row) : null
}

function summarizeBatch(items: BatchItemResult[]): BatchResult {
  return {
    items,
    succeeded: items.filter((item) => item.status === 'success').length,
    blocked: items.filter((item) => item.status === 'blocked').length,
    skipped: items.filter((item) => item.status === 'skipped').length,
  }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
