/**
 * 变更控制专用流转服务。
 *
 * 其他模块走 local-service 的通用 runAction；变更控制因为有批量评估、按涉及工序
 * 逐级审批、生效日期校验这些自己的规矩，全部收在这一个文件里，页面只调这里。
 *
 * 已定下的硬规矩（改动前先改这里，不要各页面各自发挥）：
 * 1. 变更类别与生效日期冲突时，以变更类别为准：类别决定合法生效窗口，日期落不进
 *    窗口按非法值打回重填，而不是反过来按日期去改类别。
 * 2. 生效日期全系统只有一份，存在变更记录的「生效日期」字段上；变更控制列表和
 * 供应商审计待办都经 effectiveDateOf() 读同一份，不复制第二处。
 * 3. 同一份变更重复评估只算一次：评估次数只从 0 到 1，重复提交是幂等空操作。
 * 4. 审批按涉及工序一节一节推进，只能审当前这一节，越级一律挡回。
 */
import { listRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'

export const CHANGE_KEY = 'changecontrol'

/** 供应商审计既是一个业务模块，也是变更审批流里的一节工序。 */
export const SUPPLIER_STAGE = '供应商审计'

/** 涉及工序没填时的兜底审批节，保证每条变更至少有一节可审。 */
const FALLBACK_STAGE = '质量负责人'

type DateRule = { minOffsetDays: number; maxOffsetDays: number; note: string }

/**
 * 各类变更的合法生效窗口（相对评估当日偏移天数）。
 * 冲突裁定：以变更类别为准 —— 生效日期必须落在类别允许的窗口里。
 */
export const CATEGORY_DATE_RULES: Record<string, DateRule> = {
  紧急变更: { minOffsetDays: -3650, maxOffsetDays: 0, note: '紧急变更立即生效，生效日期不得晚于当日' },
  重大变更: { minOffsetDays: 30, maxOffsetDays: 3650, note: '重大变更须留监管备案期，生效日期不得早于评估日起 30 天' },
  一般变更: { minOffsetDays: 0, maxOffsetDays: 3650, note: '一般变更不得追溯生效，生效日期不得早于当日' },
}

const DEFAULT_CATEGORY = '一般变更'

export type EvaluationForm = {
  评估人: string
  风险等级: string
  评估意见: string
}

export type RiskForm = EvaluationForm & {
  变更编号: string
  涉及工序: string[]
  评估日期: string
  风险评估依据: string
}

export type HistoryEntry = { 时间: string; 动作: string; 说明: string }

export type BatchItemKind = 'ok' | 'duplicate' | 'missing-field' | 'invalid-date' | 'blocked'

export type BatchItem = {
  id: number
  label: string
  ok: boolean
  kind: BatchItemKind
  message: string
}

export type SupplierTodo = {
  id: number
  变更编号: string
  变更类别: string
  变更内容: string
  生效日期: string
  审批进度: string
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

/** 本地时区的当天，YYYY-MM-DD。 */
export function todayKey(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`
}

function nowStamp(): string {
  const now = new Date()
  return `${todayKey(now)} ${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`
}

/** 严格校验 YYYY-MM-DD 且是真实存在的日历日，合法则返回规范化后的串，否则 null。 */
export function normalizeDateKey(raw: string): string | null {
  const text = raw.trim()
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (!match) {
    return null
  }
  const [, ys, ms, ds] = match
  const date = new Date(Date.UTC(Number(ys), Number(ms) - 1, Number(ds)))
  if (
    date.getUTCFullYear() !== Number(ys) ||
    date.getUTCMonth() !== Number(ms) - 1 ||
    date.getUTCDate() !== Number(ds)
  ) {
    return null
  }
  return `${ys}-${ms}-${ds}`
}

function keyToUtc(key: string): number {
  const [y, m, d] = key.split('-').map(Number)
  return Date.UTC(y, m - 1, d)
}

function offsetDays(fromKey: string, toKey: string): number {
  return Math.round((keyToUtc(toKey) - keyToUtc(fromKey)) / 86400000)
}

function categoryOf(row: EntryRow): string {
  const category = String(row['变更类别'] ?? '').trim()
  return category || DEFAULT_CATEGORY
}

export function dateRuleFor(category: string): DateRule {
  return CATEGORY_DATE_RULES[category.trim()] ?? CATEGORY_DATE_RULES[DEFAULT_CATEGORY]
}

/**
 * 生效日期校验：先验格式，再按「以变更类别为准」的窗口验冲突。
 * 返回 value 为规范化后的日期串，调用方落库时用它，保证两处读到的是同一份。
 */
export function checkEffectiveDate(
  category: string,
  raw: string,
  today: string = todayKey(),
): { ok: boolean; value: string; message: string } {
  const key = normalizeDateKey(raw)
  if (!key) {
    return { ok: false, value: '', message: `生效日期「${raw.trim() || '空'}」不是合法的日历日期（要求 YYYY-MM-DD）` }
  }
  const rule = dateRuleFor(category)
  const offset = offsetDays(today, key)
  if (offset < rule.minOffsetDays || offset > rule.maxOffsetDays) {
    return {
      ok: false,
      value: key,
      message: `生效日期 ${key} 与变更类别「${category.trim() || DEFAULT_CATEGORY}」冲突：${rule.note}（冲突时以变更类别为准）`,
    }
  }
  return { ok: true, value: key, message: '' }
}

/** 生效日期唯一读取口：变更列表、供应商审计待办、导出都从这里拿，保证同一份。 */
export function effectiveDateOf(row: EntryRow): string {
  return String(row['生效日期'] ?? '').trim()
}

/** 涉及工序拆成审批节；空工序兜底一节，保证流程走得下去。 */
export function stagesOf(row: EntryRow): string[] {
  const text = String(row['涉及工序'] ?? '')
  const stages = text
    .split(/[,，、;；/]+/)
    .map((item) => item.trim())
    .filter(Boolean)
  return stages.length > 0 ? stages : [FALLBACK_STAGE]
}

/** 已审完的节数，也是当前待审节的下标。 */
export function progressOf(row: EntryRow): number {
  const value = Number(row['审批进度'] ?? 0)
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

/** 当前待审工序；全部审完返回空串。 */
export function currentStageOf(row: EntryRow): string {
  const stages = stagesOf(row)
  const progress = progressOf(row)
  return progress < stages.length ? stages[progress] : ''
}

export function progressText(row: EntryRow): string {
  const stages = stagesOf(row)
  const progress = progressOf(row)
  if (progress >= stages.length) {
    return `${stages.length}/${stages.length} 节 · 已审完`
  }
  return `${progress}/${stages.length} 节 · 当前：${stages[progress]}`
}

export function evaluationCountOf(row: EntryRow): number {
  const value = Number(row['评估次数'] ?? 0)
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

export function needsDateRefill(row: EntryRow): boolean {
  return row['日期待重填'] === true
}

export function riskFormOf(row: EntryRow): RiskForm | null {
  const raw = String(row['风险评估表'] ?? '')
  if (!raw) {
    return null
  }
  try {
    return JSON.parse(raw) as RiskForm
  } catch {
    return null
  }
}

export function historyOf(row: EntryRow): HistoryEntry[] {
  const raw = String(row['流转记录'] ?? '')
  if (!raw) {
    return []
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? (parsed as HistoryEntry[]) : []
  } catch {
    return []
  }
}

function labelOf(row: EntryRow): string {
  return String(row['变更编号'] ?? `#${row.id}`)
}

function findRow(rows: EntryRow[], id: number): number {
  return rows.findIndex((row) => Number(row.id) === id)
}

/**
 * 批量提交评估：勾几条评几条，逐条给结果。
 * 缺变更类别或缺风险评估的单独拎出来（kind = missing-field），不拦其余照常推进；
 * 生效日期非法或与类别冲突的打回重填（kind = invalid-date）；
 * 已评估过的重复提交只计一次（kind = duplicate），状态不动。
 */
export function submitEvaluation(ids: number[], form: EvaluationForm): { items: BatchItem[] } {
  if (!form.评估人.trim() || !form.风险等级.trim() || !form.评估意见.trim()) {
    return {
      items: ids.map((id) => ({
        id,
        label: `#${id}`,
        ok: false,
        kind: 'blocked' as const,
        message: '评估意见必须附风险评估表：评估人、风险等级、评估意见缺一不可，整批未提交',
      })),
    }
  }
  const rows = listRows(CHANGE_KEY)
  const next = [...rows]
  const items: BatchItem[] = []
  let changed = false
  for (const id of ids) {
    const index = findRow(next, id)
    if (index < 0) {
      items.push({ id, label: `#${id}`, ok: false, kind: 'blocked', message: '记录不存在，可能已被删除' })
      continue
    }
    const row = next[index]
    const label = labelOf(row)
    if (evaluationCountOf(row) >= 1) {
      items.push({ id, label, ok: true, kind: 'duplicate', message: '这份变更已评估过，重复评估只计一次，状态不再变动' })
      continue
    }
    if (String(row.status) !== '待评估') {
      items.push({ id, label, ok: false, kind: 'blocked', message: `当前状态「${row.status}」不能提交评估` })
      continue
    }
    const missing = ['变更类别', '风险评估'].filter((field) => !String(row[field] ?? '').trim())
    if (missing.length > 0) {
      items.push({ id, label, ok: false, kind: 'missing-field', message: `缺${missing.join('、')}，未提交，请先补齐再评` })
      continue
    }
    const check = checkEffectiveDate(categoryOf(row), effectiveDateOf(row))
    if (!check.ok) {
      next[index] = { ...row, 日期待重填: true, abnormal: true }
      changed = true
      items.push({ id, label, ok: false, kind: 'invalid-date', message: `${check.message}，已打回重填` })
      continue
    }
    const stages = stagesOf(row)
    const riskForm: RiskForm = {
      变更编号: label,
      涉及工序: stages,
      风险等级: form.风险等级.trim(),
      评估意见: form.评估意见.trim(),
      评估人: form.评估人.trim(),
      评估日期: todayKey(),
      风险评估依据: String(row['风险评估'] ?? '').trim(),
    }
    const history: HistoryEntry[] = [
      ...historyOf(row),
      { 时间: nowStamp(), 动作: '提交评估', 说明: `评估人 ${riskForm.评估人}，风险等级 ${riskForm.风险等级}，进入第 1 节「${stages[0]}」审批` },
    ]
    next[index] = {
      ...row,
      status: '评估中',
      pending: true,
      abnormal: false,
      生效日期: check.value,
      日期待重填: false,
      评估次数: 1,
      审批进度: 0,
      评估意见: riskForm.评估意见,
      风险评估表: JSON.stringify(riskForm),
      流转记录: JSON.stringify(history),
    }
    changed = true
    items.push({ id, label, ok: true, kind: 'ok', message: `评估完成，进入第 1 节「${stages[0]}」审批（共 ${stages.length} 节）` })
  }
  if (changed) {
    saveRows(CHANGE_KEY, next)
  }
  return { items }
}

/**
 * 审批当前这一节工序。只能审 stagesOf(row)[审批进度] 这一节，
 * 传进来的工序对不上就是越级，一律挡回。
 */
export function approveStage(id: number, stage: string, actor: string): ActionResult {
  const rows = listRows(CHANGE_KEY)
  const index = findRow(rows, id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的变更申请` }
  }
  const row = rows[index]
  const label = labelOf(row)
  if (String(row.status) !== '评估中') {
    return { ok: false, message: `变更 ${label} 当前状态「${row.status}」，不在审批流中` }
  }
  const stages = stagesOf(row)
  const progress = progressOf(row)
  const current = stages[progress]
  if (stage !== current) {
    return { ok: false, message: `越级审批已挡回：变更 ${label} 当前应审第 ${progress + 1} 节「${current}」，不能越级审「${stage}」` }
  }
  const nextProgress = progress + 1
  const done = nextProgress >= stages.length
  const history: HistoryEntry[] = [
    ...historyOf(row),
    { 时间: nowStamp(), 动作: '工序审批', 说明: `${actor} 通过第 ${nextProgress} 节「${stage}」` },
  ]
  if (done) {
    history.push({ 时间: nowStamp(), 动作: '批准完成', 说明: `全部 ${stages.length} 节工序审批通过，变更生效日期 ${effectiveDateOf(row)}` })
  }
  const next = [...rows]
  next[index] = {
    ...row,
    status: done ? '已批准' : '评估中',
    pending: !done,
    审批进度: nextProgress,
    流转记录: JSON.stringify(history),
  }
  saveRows(CHANGE_KEY, next)
  if (done) {
    return { ok: true, message: `变更 ${label} 全部 ${stages.length} 节工序审批完成，状态「已批准」` }
  }
  return { ok: true, message: `变更 ${label} 第 ${nextProgress} 节「${stage}」已通过，进入第 ${nextProgress + 1} 节「${stages[nextProgress]}」` }
}

/**
 * 整组批准：每条变更从当前节开始一节一节往前走，不跳节；
 * 没评估过的直接批准属越级，挡回。
 */
export function approveGroup(ids: number[], actor: string): { items: BatchItem[] } {
  const items: BatchItem[] = []
  for (const id of ids) {
    const row = listRows(CHANGE_KEY).find((item) => Number(item.id) === id)
    if (!row) {
      items.push({ id, label: `#${id}`, ok: false, kind: 'blocked', message: '记录不存在，可能已被删除' })
      continue
    }
    const label = labelOf(row)
    const status = String(row.status)
    if (status === '待评估') {
      items.push({ id, label, ok: false, kind: 'blocked', message: '尚未提交评估，直接批准属越级，已挡回' })
      continue
    }
    if (status !== '评估中') {
      items.push({ id, label, ok: false, kind: 'blocked', message: `当前状态「${status}」，不能批准` })
      continue
    }
    let steps = 0
    let lastMessage = ''
    let failed = ''
    while (true) {
      const current = listRows(CHANGE_KEY).find((item) => Number(item.id) === id)
      if (!current || String(current.status) !== '评估中') {
        break
      }
      const result = approveStage(id, currentStageOf(current), actor)
      if (!result.ok) {
        failed = result.message
        break
      }
      lastMessage = result.message
      steps += 1
    }
    if (failed) {
      items.push({ id, label, ok: false, kind: 'blocked', message: `推进 ${steps} 节后被挡回：${failed}` })
    } else {
      items.push({ id, label, ok: true, kind: 'ok', message: `逐节通过 ${steps} 节工序。${lastMessage}` })
    }
  }
  return { items }
}

/** 整组退回：待评估、评估中的变更退回为「已拒绝」；已批准的不许退。 */
export function rejectChanges(ids: number[], actor: string): { items: BatchItem[] } {
  const rows = listRows(CHANGE_KEY)
  const next = [...rows]
  const items: BatchItem[] = []
  let changed = false
  for (const id of ids) {
    const index = findRow(next, id)
    if (index < 0) {
      items.push({ id, label: `#${id}`, ok: false, kind: 'blocked', message: '记录不存在，可能已被删除' })
      continue
    }
    const row = next[index]
    const label = labelOf(row)
    const status = String(row.status)
    if (status === '已拒绝') {
      items.push({ id, label, ok: true, kind: 'duplicate', message: '已是「已拒绝」，不重复退回' })
      continue
    }
    if (status === '已批准') {
      items.push({ id, label, ok: false, kind: 'blocked', message: '已批准的变更不能退回，如需废止请走新变更' })
      continue
    }
    const history: HistoryEntry[] = [
      ...historyOf(row),
      { 时间: nowStamp(), 动作: '退回变更', 说明: `${actor} 在「${status}」状态退回，变更关闭` },
    ]
    next[index] = {
      ...row,
      status: '已拒绝',
      pending: false,
      abnormal: true,
      流转记录: JSON.stringify(history),
    }
    changed = true
    items.push({ id, label, ok: true, kind: 'ok', message: `已从「${status}」退回，状态「已拒绝」` })
  }
  if (changed) {
    saveRows(CHANGE_KEY, next)
  }
  return { items }
}

/** 生效日期打回重填后的重新填写：同样过格式 + 类别窗口校验，过了才落库。 */
export function refillEffectiveDate(id: number, value: string): ActionResult {
  const rows = listRows(CHANGE_KEY)
  const index = findRow(rows, id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的变更申请` }
  }
  const row = rows[index]
  const label = labelOf(row)
  const check = checkEffectiveDate(categoryOf(row), value)
  if (!check.ok) {
    return { ok: false, message: `${check.message}，请重新填写` }
  }
  const history: HistoryEntry[] = [
    ...historyOf(row),
    { 时间: nowStamp(), 动作: '重填生效日期', 说明: `生效日期重填为 ${check.value}，校验通过，可重新提交评估` },
  ]
  const next = [...rows]
  next[index] = {
    ...row,
    生效日期: check.value,
    日期待重填: false,
    abnormal: false,
    流转记录: JSON.stringify(history),
  }
  saveRows(CHANGE_KEY, next)
  return { ok: true, message: `变更 ${label} 生效日期已重填为 ${check.value}，可重新提交评估` }
}

/**
 * 供应商审计模块的变更待办：审批流走到「供应商审计」这一节的变更。
 * 生效日期经 effectiveDateOf 从变更记录上读，和变更控制列表是同一份。
 */
export function supplierTodos(): SupplierTodo[] {
  return listRows(CHANGE_KEY)
    .filter((row) => String(row.status) === '评估中' && currentStageOf(row) === SUPPLIER_STAGE)
    .map((row) => ({
      id: Number(row.id),
      变更编号: labelOf(row),
      变更类别: categoryOf(row),
      变更内容: String(row['变更内容'] ?? ''),
      生效日期: effectiveDateOf(row),
      审批进度: progressText(row),
    }))
}

export function supplierTodoCount(): number {
  return supplierTodos().length
}
