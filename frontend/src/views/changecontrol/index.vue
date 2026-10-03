<template>
  <section class="page" data-module="changecontrol">
    <header class="page-head">
      <div>
        <h2>变更控制管理</h2>
        <p class="page-desc">
          变更按涉及工序串行会签：批量提交评估（逐条出结果）→ 整组批准/退回 → 全部工序会签通过后批准生效，供应商类变更同步落到供应商审计待办。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportRows">导出变更控制清单</button>
      </div>
    </header>

    <div class="rule-banner">
      <strong>仲裁规则（已定）：</strong>变更类别与生效日期冲突时，<em>以变更类别为准</em>——
      重大变更最早生效日为评估日后第 30 天，中等变更第 7 天，微小变更随批；生效日期非法一律打回重填。
      同一份变更重复评估只算一次。
    </div>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label class="filter-item">
        <span>变更编号</span>
        <input v-model="filters['变更编号']" placeholder="按变更编号检索" />
      </label>
      <label class="filter-item">
        <span>变更类别</span>
        <input v-model="filters['变更类别']" placeholder="按变更类别检索" />
      </label>
      <label class="filter-item">
        <span>涉及工序</span>
        <input v-model="filters['涉及工序']" placeholder="按涉及工序检索" />
      </label>
      <label class="filter-item">
        <span>状态</span>
        <select v-model="statusFilter">
          <option value="">全部状态</option>
          <option v-for="item in allStatuses" :key="item" :value="item">{{ item }}</option>
        </select>
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <!-- 批量操作条：勾住多条一起提交评估；评估完的整组批准/整组退回 -->
    <div class="batch-bar">
      <label class="batch-check">
        <input type="checkbox" :checked="allFilteredSelected" @change="toggleSelectAll" />
        全选当前列表（已选 {{ selectedList.length }} 条）
      </label>
      <button class="btn primary" type="button" :disabled="!selectedList.length" @click="openBatchEvaluation">
        批量提交评估
      </button>
      <button class="btn" type="button" :disabled="!selectedList.length" @click="openGroupApprove">
        整组批准（逐工序会签）
      </button>
      <button class="btn danger" type="button" :disabled="!selectedList.length" @click="openGroupReject">
        整组退回
      </button>
    </div>

    <table class="data-table">
      <thead>
        <tr>
          <th class="col-check">选择</th>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in filteredRows" :key="String(row.id)" :class="{ 'row-selected': selectedIds.has(Number(row.id)) }">
          <td class="col-check">
            <input type="checkbox" :value="Number(row.id)" v-model="selectedList" />
          </td>
          <td v-for="column in columns" :key="column" :title="String(row[column] ?? '')">
            <template v-if="column === '风险评估'">
              <span :class="{ 'cell-missing': !row[column] }">{{ row[column] || '缺失，需补填' }}</span>
            </template>
            <template v-else-if="column === '变更类别'">
              <span :class="{ 'cell-missing': !row[column] }">{{ row[column] || '缺失，需补填' }}</span>
            </template>
            <template v-else-if="column === '生效日期'">
              <span :class="{ 'cell-invalid': !isValidDateCell(row[column]) }">{{ effectiveDateOf(row) || '未填写' }}</span>
            </template>
            <template v-else>{{ row[column] || '—' }}</template>
          </td>
          <td>
            <span class="status-pill" :class="statusClass(row)">{{ row.status }}</span>
            <small v-if="isStage(row.status)" class="stage-hint">
              会签 {{ trackOf(row).length }}/{{ splitStages(row['涉及工序']).length }}
            </small>
          </td>
          <td class="row-actions">
            <button v-if="canEvaluate(row)" class="link" type="button" @click="openSingleEvaluation(row)">
              提交评估
            </button>
            <button v-if="isStage(row.status)" class="link" type="button" @click="openSingleApprove(row)">
              本工序会签
            </button>
            <button v-if="row.status === '待评估'" class="link" type="button" @click="openEdit(row)">
              补填重填
            </button>
            <button v-if="row.status === '评估中' || isStage(row.status)" class="link danger-link" type="button" @click="openSingleReject(row)">
              退回
            </button>
            <button v-if="row.status === '已退回'" class="link" type="button" @click="reopenRow(row)">
              重新登记
            </button>
            <button class="link" type="button" @click="openDetail(row)">详情</button>
          </td>
        </tr>
        <tr v-if="!filteredRows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无变更控制数据</td>
        </tr>
      </tbody>
    </table>

    <!-- 批量结果：成功推进、缺字段/非法日期挡回、重复评估跳过，三类逐条理清楚 -->
    <section v-if="batchResult" class="result-panel">
      <header class="result-head">
        <h3>批量处理结果</h3>
        <span>成功 {{ batchResult.succeeded }} 条 · 挡回 {{ batchResult.blocked }} 条 · 重复跳过 {{ batchResult.skipped }} 条</span>
        <button class="link" type="button" @click="batchResult = null">关闭</button>
      </header>
      <ul class="result-list">
        <li v-for="item in batchResult.items" :key="item.id" :class="`result-${item.status}`">
          <strong>{{ item.label }}</strong>
          <span class="result-tag">{{ resultTag(item.status) }}</span>
          <span>{{ item.message }}</span>
        </li>
      </ul>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条变更申请</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <!-- 评估弹窗：评估意见 + 风险评估表；单条与批量共用，批量时逐条校验、逐条出结果 -->
    <div v-if="evaluationDialog.open" class="modal-mask" @click.self="closeEvaluation">
      <div class="modal modal-wide">
        <h3>{{ evaluationDialog.mode === 'batch' ? `批量提交评估（${evaluationDialog.ids.length} 条）` : '提交评估' }}</h3>
        <p class="modal-tip">
          评估意见须附风险评估表；缺变更类别/风险评估、生效日期非法或不满足类别前置期的会被单独挡回，其余照常推进。
          生效日期统一取清单中同一份，无需在此重复填写。
        </p>
        <label class="form-row">
          <span>评估人</span>
          <input v-model="evaluationDialog.evaluator" placeholder="评估人姓名" />
        </label>
        <label class="form-row">
          <span>评估意见</span>
          <textarea v-model="evaluationDialog.opinion" rows="3" placeholder="给出本次评估结论，意见将随附风险评估表流转"></textarea>
        </label>
        <div class="risk-table-head">
          <span>风险评估表</span>
          <button class="btn" type="button" @click="addRiskRow">增加风险项</button>
        </div>
        <table class="risk-table">
          <thead>
            <tr>
              <th>风险点</th><th>严重性</th><th>可能性</th><th>可检测性</th><th>风险等级</th><th>控制措施</th><th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(risk, riskIndex) in evaluationDialog.risks" :key="riskIndex">
              <td><input v-model="risk.item" placeholder="如：混合均匀度" /></td>
              <td>
                <select v-model="risk.severity" @change="recalcGrade(risk)">
                  <option>高</option><option>中</option><option>低</option>
                </select>
              </td>
              <td>
                <select v-model="risk.probability" @change="recalcGrade(risk)">
                  <option>高</option><option>中</option><option>低</option>
                </select>
              </td>
              <td>
                <select v-model="risk.detectability">
                  <option>高</option><option>中</option><option>低</option>
                </select>
              </td>
              <td>
                <select v-model="risk.grade">
                  <option>高</option><option>中</option><option>低</option>
                </select>
              </td>
              <td><input v-model="risk.control" placeholder="控制/验证措施" /></td>
              <td><button class="link danger-link" type="button" @click="removeRiskRow(riskIndex)">删除</button></td>
            </tr>
          </tbody>
        </table>
        <p v-if="evaluationDialog.error" class="error-text">{{ evaluationDialog.error }}</p>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="closeEvaluation">取消</button>
          <button class="btn primary" type="button" @click="submitEvaluation">确认提交评估</button>
        </div>
      </div>
    </div>

    <!-- 会签批准弹窗：单条是一道工序，整组是各条按当前工序推进一节，不允许越级 -->
    <div v-if="approveDialog.open" class="modal-mask" @click.self="approveDialog.open = false">
      <div class="modal">
        <h3>{{ approveDialog.mode === 'batch' ? `整组批准（${approveDialog.ids.length} 条）` : '本工序会签' }}</h3>
        <p class="modal-tip">
          状态一节一节推进：每条变更只从当前工序往下走一节，全部涉及工序会签齐了才「已批准」；
          待评估/评估中/已退回的会被挡回。供应商类变更批准后自动生成供应商审计待办。
        </p>
        <label class="form-row">
          <span>会签人</span>
          <input v-model="approveDialog.approver" placeholder="当前工序审批人" />
        </label>
        <label class="form-row">
          <span>会签意见</span>
          <textarea v-model="approveDialog.opinion" rows="2" placeholder="可留空"></textarea>
        </label>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="approveDialog.open = false">取消</button>
          <button class="btn primary" type="button" @click="submitApprove">确认会签通过</button>
        </div>
      </div>
    </div>

    <!-- 退回弹窗：整组退回/单条退回都必须填退回原因 -->
    <div v-if="rejectDialog.open" class="modal-mask" @click.self="rejectDialog.open = false">
      <div class="modal">
        <h3>{{ rejectDialog.mode === 'batch' ? `整组退回（${rejectDialog.ids.length} 条）` : '退回变更' }}</h3>
        <p class="modal-tip">退回后变更状态落「已退回」并标记异常，待评估状态的请直接用「补填重填」。</p>
        <label class="form-row">
          <span>退回原因</span>
          <textarea v-model="rejectDialog.reason" rows="3" placeholder="写明退回原因，必填"></textarea>
        </label>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="rejectDialog.open = false">取消</button>
          <button class="btn danger" type="button" @click="submitReject">确认退回</button>
        </div>
      </div>
    </div>

    <!-- 补填重填弹窗：被打回的待评估变更在这里修正类别/工序/风险评估/生效日期 -->
    <div v-if="editDialog.open" class="modal-mask" @click.self="editDialog.open = false">
      <div class="modal">
        <h3>补填 / 重填变更资料（{{ editDialog.code }}）</h3>
        <label class="form-row">
          <span>变更类别</span>
          <select v-model="editDialog.category">
            <option value="">请选择</option>
            <option v-for="category in categoryOptions" :key="category" :value="category">{{ category }}</option>
          </select>
        </label>
        <label class="form-row">
          <span>涉及工序</span>
          <input v-model="editDialog.process" placeholder="多个工序用顿号分隔，按此顺序串行会签" />
        </label>
        <label class="form-row">
          <span>风险评估结论</span>
          <textarea v-model="editDialog.risk" rows="2"></textarea>
        </label>
        <label class="form-row">
          <span>生效日期</span>
          <input v-model="editDialog.effectiveDate" placeholder="YYYY-MM-DD" />
          <small class="form-hint">
            以类别为准：本类别最早生效日 {{ editEarliest }}；非法日期无法保存。
          </small>
        </label>
        <label class="form-row">
          <span>申请人</span>
          <input v-model="editDialog.approver" />
        </label>
        <p v-if="editDialog.error" class="error-text">{{ editDialog.error }}</p>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="editDialog.open = false">取消</button>
          <button class="btn primary" type="button" @click="submitEdit">保存补填</button>
        </div>
      </div>
    </div>

    <!-- 详情：评估意见 + 风险评估表 + 逐工序会签记录 -->
    <div v-if="detailRow" class="modal-mask" @click.self="detailRow = null">
      <div class="modal modal-wide">
        <h3>变更详情 · {{ detailRow['变更编号'] }}</h3>
        <dl class="detail-grid">
          <dt>变更类别</dt><dd>{{ detailRow['变更类别'] || '—' }}</dd>
          <dt>涉及工序</dt><dd>{{ detailRow['涉及工序'] || '—' }}</dd>
          <dt>变更内容</dt><dd>{{ detailRow['变更内容'] || '—' }}</dd>
          <dt>生效日期</dt><dd>{{ effectiveDateOf(detailRow) || '—' }}（统一读取入口）</dd>
          <dt>当前状态</dt><dd>{{ detailRow.status }}</dd>
          <dt>风险评估结论</dt><dd>{{ detailRow['风险评估'] || '—' }}</dd>
        </dl>
        <h4>评估意见</h4>
        <p v-if="detailEvaluation">{{ detailEvaluation.evaluator }} · {{ detailEvaluation.evaluatedAt }}：{{ detailEvaluation.opinion }}</p>
        <p v-else class="muted-text">尚未评估</p>
        <h4>风险评估表</h4>
        <table v-if="detailEvaluation && detailEvaluation.risks.length" class="risk-table">
          <thead>
            <tr><th>风险点</th><th>严重性</th><th>可能性</th><th>可检测性</th><th>风险等级</th><th>控制措施</th></tr>
          </thead>
          <tbody>
            <tr v-for="(risk, index) in detailEvaluation.risks" :key="index">
              <td>{{ risk.item }}</td><td>{{ risk.severity }}</td><td>{{ risk.probability }}</td>
              <td>{{ risk.detectability }}</td><td>{{ risk.grade }}</td><td>{{ risk.control }}</td>
            </tr>
          </tbody>
        </table>
        <p v-else class="muted-text">暂无风险评估表</p>
        <h4>工序会签记录</h4>
        <table v-if="trackOf(detailRow).length" class="risk-table">
          <thead><tr><th>工序</th><th>会签人</th><th>时间</th><th>意见</th></tr></thead>
          <tbody>
            <tr v-for="(item, index) in trackOf(detailRow)" :key="index">
              <td>{{ item.stage }}</td><td>{{ item.approver }}</td><td>{{ item.approvedAt }}</td><td>{{ item.opinion }}</td>
            </tr>
          </tbody>
        </table>
        <p v-else class="muted-text">尚未进入工序会签</p>
        <div class="modal-actions">
          <button class="btn primary" type="button" @click="detailRow = null">关闭</button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  approveChangeStage,
  approveChangesAsGroup,
  changeEvaluation,
  downloadEntries,
  listEntries,
  moduleMeta,
  rejectChange,
  rejectChangesAsGroup,
  reopenChange,
  submitChangeEvaluation,
  submitChangeEvaluations,
  updateChangeDraft,
} from '@/api/local-service'
import {
  CHANGE_CATEGORIES,
  earliestEffectiveDate,
  effectiveDateOf,
  emptyRiskRow,
  gradeRisk,
  isStageStatus,
  isValidDate,
  splitStages,
  todayText,
  trackOf,
} from '@/data/changecontrol'
import type { BatchResult, EntryRow } from '@/data/types'
import type { RiskRow } from '@/data/changecontrol'
import { useSessionStore } from '@/stores/session'

const meta = moduleMeta('changecontrol')
const session = useSessionStore()

// 展示列不含重复的「变更状态」（状态单独一列）与评估附件列（在详情中展示）。
const columns = ['变更编号', '变更类别', '涉及工序', '变更内容', '风险评估', '审批人', '生效日期']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const statusFilter = ref('')
const selectedList = ref<number[]>([])
const batchResult = ref<BatchResult | null>(null)

const selectedIds = computed(() => new Set(selectedList.value))

const categoryOptions = [
  ...CHANGE_CATEGORIES,
  ...CHANGE_CATEGORIES.map((category) => `${category}-供应商`),
]

const allStatuses = computed(() => {
  const dynamic = new Set<string>()
  for (const row of rows.value) {
    if (isStageStatus(String(row.status))) {
      dynamic.add(String(row.status))
    }
  }
  return [...meta.statuses, ...dynamic]
})

const filteredRows = computed(() => {
  if (!statusFilter.value) {
    return rows.value
  }
  return rows.value.filter((row) => String(row.status) === statusFilter.value)
})

const allFilteredSelected = computed(
  () => filteredRows.value.length > 0 && filteredRows.value.every((row) => selectedIds.value.has(Number(row.id))),
)

const stats = computed(() => {
  const month = todayText().slice(0, 7)
  return [
    { label: '待评估变更', value: rows.value.filter((row) => row.status === '待评估').length },
    { label: '工序会签中', value: rows.value.filter((row) => isStageStatus(String(row.status))).length },
    {
      label: '本月批准数',
      value: rows.value.filter(
        (row) =>
          row.status === '已批准' &&
          trackOf(row).some((item) => String(item.approvedAt).slice(0, 7) === month),
      ).length,
    },
  ]
})

const statusSummary = computed(() =>
  allStatuses.value.map((status) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const detailRow = ref<EntryRow | null>(null)
const detailEvaluation = computed(() => (detailRow.value ? changeEvaluation(Number(detailRow.value.id)) : null))

function canEvaluate(row: EntryRow): boolean {
  return row.status === '待评估' || row.status === '评估中'
}

function isStage(status: string): boolean {
  return isStageStatus(status)
}

function isValidDateCell(value: unknown): boolean {
  const text = String(value ?? '').trim()
  return text === '' || isValidDate(text)
}

function statusClass(row: EntryRow): string {
  if (row.status === '已批准') {
    return 'pill-approved'
  }
  if (row.status === '已退回') {
    return 'pill-returned'
  }
  if (isStageStatus(String(row.status))) {
    return 'pill-stage'
  }
  return ''
}

function resultTag(status: string): string {
  if (status === 'success') {
    return '已推进'
  }
  if (status === 'skipped') {
    return '重复跳过'
  }
  return '挡回'
}

function toggleSelectAll(): void {
  if (allFilteredSelected.value) {
    const visibleIds = new Set(filteredRows.value.map((row) => Number(row.id)))
    selectedList.value = selectedList.value.filter((id) => !visibleIds.has(id))
    return
  }
  const merged = new Set([...selectedList.value, ...filteredRows.value.map((row) => Number(row.id))])
  selectedList.value = [...merged]
}

// -- 评估弹窗 ----------------------------------------------------------------

const evaluationDialog = reactive({
  open: false,
  mode: 'single' as 'single' | 'batch',
  ids: [] as number[],
  evaluator: session.operator,
  opinion: '',
  risks: [emptyRiskRow()] as RiskRow[],
  error: '',
})

function resetEvaluationDialog(mode: 'single' | 'batch', ids: number[]): void {
  evaluationDialog.mode = mode
  evaluationDialog.ids = ids
  evaluationDialog.evaluator = session.operator
  evaluationDialog.opinion = ''
  evaluationDialog.risks = [emptyRiskRow()]
  evaluationDialog.error = ''
  evaluationDialog.open = true
}

function openSingleEvaluation(row: EntryRow): void {
  resetEvaluationDialog('single', [Number(row.id)])
}

function openBatchEvaluation(): void {
  if (!selectedList.value.length) {
    return
  }
  resetEvaluationDialog('batch', [...selectedList.value])
}

function closeEvaluation(): void {
  evaluationDialog.open = false
}

function addRiskRow(): void {
  evaluationDialog.risks.push(emptyRiskRow())
}

function removeRiskRow(index: number): void {
  evaluationDialog.risks.splice(index, 1)
}

function recalcGrade(risk: RiskRow): void {
  risk.grade = gradeRisk(risk.severity, risk.probability)
}

function submitEvaluation(): void {
  const input = {
    opinion: evaluationDialog.opinion,
    risks: evaluationDialog.risks,
    evaluator: evaluationDialog.evaluator,
  }
  const result =
    evaluationDialog.mode === 'batch'
      ? submitChangeEvaluations(evaluationDialog.ids, input)
      : asBatchResult(submitChangeEvaluation(evaluationDialog.ids[0], input))
  evaluationDialog.open = false
  batchResult.value = result
  reload()
}

// 单条结果包成批量结果结构，页面只用一套结果面板。
function asBatchResult(item: BatchResult['items'][number]): BatchResult {
  return {
    items: [item],
    succeeded: item.status === 'success' ? 1 : 0,
    blocked: item.status === 'blocked' ? 1 : 0,
    skipped: item.status === 'skipped' ? 1 : 0,
  }
}

// -- 会签批准弹窗 -------------------------------------------------------------

const approveDialog = reactive({
  open: false,
  mode: 'single' as 'single' | 'batch',
  ids: [] as number[],
  approver: session.operator,
  opinion: '',
})

function openSingleApprove(row: EntryRow): void {
  approveDialog.open = true
  approveDialog.mode = 'single'
  approveDialog.ids = [Number(row.id)]
  approveDialog.approver = session.operator
  approveDialog.opinion = ''
}

function openGroupApprove(): void {
  if (!selectedList.value.length) {
    return
  }
  approveDialog.open = true
  approveDialog.mode = 'batch'
  approveDialog.ids = [...selectedList.value]
  approveDialog.approver = session.operator
  approveDialog.opinion = ''
}

function submitApprove(): void {
  const result =
    approveDialog.mode === 'batch'
      ? approveChangesAsGroup(approveDialog.ids, approveDialog.approver, approveDialog.opinion)
      : asBatchResult(approveChangeStage(approveDialog.ids[0], approveDialog.approver, approveDialog.opinion))
  approveDialog.open = false
  batchResult.value = result
  reload()
}

// -- 退回弹窗 ----------------------------------------------------------------

const rejectDialog = reactive({
  open: false,
  mode: 'single' as 'single' | 'batch',
  ids: [] as number[],
  reason: '',
})

function openSingleReject(row: EntryRow): void {
  rejectDialog.open = true
  rejectDialog.mode = 'single'
  rejectDialog.ids = [Number(row.id)]
  rejectDialog.reason = ''
}

function openGroupReject(): void {
  if (!selectedList.value.length) {
    return
  }
  rejectDialog.open = true
  rejectDialog.mode = 'batch'
  rejectDialog.ids = [...selectedList.value]
  rejectDialog.reason = ''
}

function submitReject(): void {
  if (!rejectDialog.reason.trim()) {
    errorMessage.value = '退回原因必填'
    return
  }
  const result =
    rejectDialog.mode === 'batch'
      ? rejectChangesAsGroup(rejectDialog.ids, rejectDialog.reason)
      : asBatchResult(rejectChange(rejectDialog.ids[0], rejectDialog.reason))
  rejectDialog.open = false
  batchResult.value = result
  reload()
}

// -- 补填重填弹窗 -------------------------------------------------------------

const editDialog = reactive({
  open: false,
  id: 0,
  code: '',
  category: '',
  process: '',
  risk: '',
  effectiveDate: '',
  approver: '',
  error: '',
})

function openEdit(row: EntryRow): void {
  editDialog.open = true
  editDialog.id = Number(row.id)
  editDialog.code = String(row['变更编号'] ?? '')
  editDialog.category = String(row['变更类别'] ?? '')
  editDialog.process = String(row['涉及工序'] ?? '')
  editDialog.risk = String(row['风险评估'] ?? '')
  editDialog.effectiveDate = effectiveDateOf(row)
  editDialog.approver = String(row['审批人'] ?? '')
  editDialog.error = ''
}

const editEarliest = computed(() => {
  const match = CHANGE_CATEGORIES.find((category) => editDialog.category.startsWith(category))
  return match ? earliestEffectiveDate(match) : '—'
})

function submitEdit(): void {
  const result = updateChangeDraft(editDialog.id, {
    category: editDialog.category,
    process: editDialog.process,
    risk: editDialog.risk,
    effectiveDate: editDialog.effectiveDate,
    approver: editDialog.approver,
  })
  if (!result.ok) {
    editDialog.error = result.message
    return
  }
  editDialog.open = false
  reload()
}

// -- 列表与导出 ---------------------------------------------------------------

function resetFilters(): void {
  filters.value = {}
  statusFilter.value = ''
  reload()
}

function exportRows(): void {
  downloadEntries(meta.key)
}

function openDetail(row: EntryRow): void {
  detailRow.value = row
}

function reopenRow(row: EntryRow): void {
  const result = reopenChange(Number(row.id))
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload(): void {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    const validIds = new Set(payload.items.map((row) => Number(row.id)))
    selectedList.value = selectedList.value.filter((id) => validIds.has(id))
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '变更控制列表读取失败'
  }
}

onMounted(reload)
</script>
