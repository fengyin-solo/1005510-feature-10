/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  // 风险评估表、工序流转记录这类结构化附件也挂在行上（见 data/changecontrol.ts）。
  [field: string]: string | number | boolean | object
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

// 批量动作逐条落账：success 已推进，blocked 被规则挡回（含缺字段/越级/非法日期），skipped 命中幂等跳过。
export type BatchItemStatus = 'success' | 'blocked' | 'skipped'

export type BatchItemResult = {
  id: number
  label: string
  status: BatchItemStatus
  message: string
}

export type BatchResult = {
  items: BatchItemResult[]
  succeeded: number
  blocked: number
  skipped: number
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}
