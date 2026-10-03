import type { EntryRow } from './types'

/**
 * 变更控制专属业务规则：评估、工序会签、生效日期约束、供应商联动都集中在这里。
 * 页面只负责渲染与收集输入，状态能不能走、走到哪一节，统一由本模块 + local-service 判定。
 */

export const CHANGE_KEY = 'changecontrol'
export const AUDIT_KEY = 'supplieraudit'

// 基础状态：工序会签的状态是动态的，形如「待·配液 审批」，不在这份固定清单里。
export const BASE_STATUSES = ['待评估', '评估中', '已批准', '已退回']
export const APPROVED_STATUS = '已批准'
export const RETURNED_STATUS = '已退回'
export const EVALUATING_STATUS = '评估中'
export const PENDING_EVALUATION_STATUS = '待评估'

// 变更类别 → 最早生效前置期（自然日）。类别与生效日期冲突时「以变更类别为准」。
export const CATEGORY_LEAD_DAYS = { 重大变更: 30, 中等变更: 7, 微小变更: 0 } as const
export type ChangeCategory = keyof typeof CATEGORY_LEAD_DAYS
export const CHANGE_CATEGORIES = Object.keys(CATEGORY_LEAD_DAYS) as ChangeCategory[]

// 命中这些词的变更，批准后要落到供应商审计的待办里（按变更类别识别，类别字段取「重大变更-供应商」这种写法）。
const SUPPLIER_KEYWORD = '供应商'

export type RiskRow = {
  item: string // 风险点
  severity: string // 严重性
  probability: string // 发生可能性
  detectability: string // 可检测性
  grade: string // 风险等级
  control: string // 控制措施
}

export type EvaluationRecord = {
  opinion: string
  risks: RiskRow[]
  evaluator: string
  evaluatedAt: string
}

export type TrackItem = {
  stage: string
  approver: string
  approvedAt: string
  opinion: string
}

export type ChangeRow = EntryRow & {
  评估意见?: string
  风险表?: RiskRow[]
  评估人?: string
  评估时间?: string
  工序流转?: TrackItem[]
  来源变更?: string
}

export type EvaluationInput = {
  opinion: string
  risks: RiskRow[]
  evaluator: string
}

// 把多个工序拆成串行会签队列：「配液、灌装；灭菌」→ [配液, 灌装, 灭菌]。
export function splitStages(processText: unknown): string[] {
  return String(processText ?? '')
    .split(/[、,，;；\/\s]+/)
    .map((item) => item.trim())
    .filter(Boolean)
}

export function stageStatus(stage: string): string {
  return `待·${stage} 审批`
}

export function isStageStatus(status: string): boolean {
  return status.startsWith('待·') && status.endsWith(' 审批')
}

export function stageOf(status: string): string {
  return status.replace(/^待·/, '').replace(/ 审批$/, '')
}

// 变更类别允许写成「重大变更-供应商」，主类别必须能在前置期字典里找到，否则视为类别缺失/非法。
export function categoryOf(categoryText: unknown): ChangeCategory | null {
  const text = String(categoryText ?? '').trim()
  if (!text) {
    return null
  }
  return CHANGE_CATEGORIES.find((category) => text.startsWith(category)) ?? null
}

export function isSupplierChange(row: EntryRow): boolean {
  return String(row['变更类别'] ?? '').includes(SUPPLIER_KEYWORD)
}

// 生效日期的唯一读取入口：表格、评估弹窗、补填弹窗都走这里，保证两处读到同一份。
export function effectiveDateOf(row: EntryRow): string {
  return String(row['生效日期'] ?? '').trim()
}

// 严格校验 YYYY-MM-DD，且必须是真实日历日（2026-02-30 / 13 月一律判非法）。
export function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false
  }
  const [year, month, day] = value.split('-').map(Number)
  if (month < 1 || month > 12) {
    return false
  }
  const daysInMonth = new Date(year, month, 0).getDate()
  return day >= 1 && day <= daysInMonth
}

function toDate(value: string): Date {
  const [year, month, day] = value.split('-').map(Number)
  return new Date(year, month - 1, day)
}

function formatDate(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function todayText(): string {
  return formatDate(new Date())
}

// 以变更类别为准，算该类别允许的最早生效日期（评估提交日 + 前置期）。
export function earliestEffectiveDate(category: ChangeCategory, evaluatedAt: string = todayText()): string {
  const lead = CATEGORY_LEAD_DAYS[category]
  const date = toDate(evaluatedAt)
  date.setDate(date.getDate() + lead)
  return formatDate(date)
}

// 生效日期是否满足类别前置期；不满足即「类别与生效日期冲突」，按类别为准挡回。
export function meetsLeadDate(category: ChangeCategory, effectiveDate: string, evaluatedAt: string = todayText()): boolean {
  const floor = toDate(earliestEffectiveDate(category, evaluatedAt))
  return toDate(effectiveDate).getTime() >= floor.getTime()
}

// 风险等级 = 严重性 × 可能性，可检测性仅作展示；给个简单的三档默认算法，弹窗里也可手改。
export function gradeRisk(severity: string, probability: string): string {
  const score = levelValue(severity) * levelValue(probability)
  if (score >= 9) {
    return '高'
  }
  if (score >= 4) {
    return '中'
  }
  return '低'
}

function levelValue(value: string): number {
  const text = value.trim()
  if (text === '高' || text === '3') {
    return 3
  }
  if (text === '中' || text === '2') {
    return 2
  }
  if (text === '低' || text === '1') {
    return 1
  }
  return Number(text) || 1
}

export function emptyRiskRow(): RiskRow {
  return { item: '', severity: '中', probability: '低', detectability: '中', grade: '低', control: '' }
}

// 是否已经评估过只认「评估时间」：重新登记会清空评估时间并允许重新评估，空风险表不算数。
export function isEvaluated(row: EntryRow): boolean {
  return Boolean((row as ChangeRow)['评估时间'])
}

export function evaluationOf(row: EntryRow): EvaluationRecord | null {
  const change = row as ChangeRow
  if (!change['评估时间']) {
    return null
  }
  return {
    opinion: String(change['评估意见'] ?? ''),
    risks: Array.isArray(change['风险表']) ? change['风险表'] : [],
    evaluator: String(change['评估人'] ?? ''),
    evaluatedAt: String(change['评估时间']),
  }
}

export function trackOf(row: EntryRow): TrackItem[] {
  const change = row as ChangeRow
  return Array.isArray(change['工序流转']) ? change['工序流转'] : []
}

export function labelOf(row: EntryRow): string {
  return String(row['变更编号'] ?? row.id)
}
