<template>
  <section class="page" data-module="changecontrol">
    <header class="page-head">
      <div>
        <h2>变更控制管理</h2>
        <p class="page-desc">
          支持勾选多条变更批量提交评估、整组批准或整组退回；审批按涉及工序一节一节推进，越级挡回；评估意见附风险评估表，生效日期与变更类别冲突时以变更类别为准。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记变更申请</button>
        <button class="btn" type="button" @click="exportRows">导出变更控制清单</button>
      </div>
    </header>

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
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <div class="batch-bar">
      <span>已勾选 {{ selectedIds.length }} 条</span>
      <button class="btn primary" type="button" :disabled="!selectedIds.length" @click="openEvaluation(selectedIds)">
        批量提交评估
      </button>
      <button class="btn" type="button" :disabled="!selectedIds.length" @click="approveSelected">整组批准</button>
      <button class="btn" type="button" :disabled="!selectedIds.length" @click="rejectSelected">整组退回</button>
      <span class="batch-hint">评估意见须附风险评估表；缺变更类别或风险评估的会单独拎出来，其余照常推进</span>
    </div>

    <div v-if="batchItems.length" class="batch-result">
      <h3>批量处理结果（成功 {{ okCount }} / 共 {{ batchItems.length }} 条）</h3>
      <div v-if="missingItems.length" class="result-block">
        <strong>缺变更类别或风险评估，已单独拎出（{{ missingItems.length }} 条）：</strong>
        <ul class="result-list">
          <li v-for="item in missingItems" :key="item.id" class="fail">{{ item.label }}：{{ item.message }}</li>
        </ul>
      </div>
      <div v-if="invalidDateItems.length" class="result-block">
        <strong>生效日期问题，已打回重填（{{ invalidDateItems.length }} 条）：</strong>
        <ul class="result-list">
          <li v-for="item in invalidDateItems" :key="item.id" class="fail">{{ item.label }}：{{ item.message }}</li>
        </ul>
      </div>
      <ul class="result-list">
        <li v-for="item in batchItems" :key="item.id" :class="item.ok ? 'ok' : 'fail'">
          {{ item.ok ? '✓' : '✗' }} {{ item.label }}：{{ item.message }}
        </li>
      </ul>
      <button class="btn ghost" type="button" @click="batchItems = []">收起结果</button>
    </div>

    <table class="data-table">
      <thead>
        <tr>
          <th>
            <input type="checkbox" :checked="allSelected" @change="toggleSelectAll" />
          </th>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>审批进度</th>
          <th>评估次数</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)" :class="{ 'row-warn': needsDateRefill(row) }">
          <td>
            <input type="checkbox" :checked="isSelected(Number(row.id))" @change="toggleSelect(Number(row.id))" />
          </td>
          <td v-for="column in columns" :key="column">
            <template v-if="column === '生效日期'">
              {{ effectiveDateOf(row) || '—' }}
              <span v-if="needsDateRefill(row)" class="tag-warn">待重填</span>
            </template>
            <template v-else>{{ row[column] ?? '—' }}</template>
          </td>
          <td :title="historyText(row)">{{ progressText(row) }}</td>
          <td>{{ evaluationCountOf(row) }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-if="row.status === '待评估' && !needsDateRefill(row)"
              class="link"
              type="button"
              @click="openEvaluation([Number(row.id)])"
            >
              提交评估
            </button>
            <button v-if="row.status === '评估中'" class="link" type="button" @click="approveOne(row)">
              批准本工序
            </button>
            <button
              v-if="row.status === '待评估' || row.status === '评估中'"
              class="link"
              type="button"
              @click="rejectOne(row)"
            >
              退回变更
            </button>
            <button v-if="needsDateRefill(row)" class="link" type="button" @click="openRefill(row)">
              重填生效日期
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 5" class="empty-state">暂无变更控制数据，可先登记变更申请</td>
        </tr>
      </tbody>
    </table>

    <div v-if="evaluationDialog.open" class="dialog-mask">
      <div class="dialog">
        <h3>提交评估（{{ evaluationDialog.ids.length }} 条变更）</h3>
        <p class="dialog-desc">评估意见必须附风险评估表；同一份变更重复评估只计一次。</p>
        <label>
          评估人
          <input v-model="evaluationForm.评估人" placeholder="评估人姓名" />
        </label>
        <label>
          风险等级
          <select v-model="evaluationForm.风险等级">
            <option value="低">低</option>
            <option value="中">中</option>
            <option value="高">高</option>
          </select>
        </label>
        <label>
          评估意见
          <textarea v-model="evaluationForm.评估意见" rows="3" placeholder="评估结论与风险控制措施"></textarea>
        </label>
        <p class="dialog-desc">生效日期与变更类别冲突时以变更类别为准；非法日期将打回重填。</p>
        <p v-if="evaluationError" class="error-text">{{ evaluationError }}</p>
        <footer class="dialog-foot">
          <button class="btn primary" type="button" @click="confirmEvaluation">提交评估</button>
          <button class="btn ghost" type="button" @click="evaluationDialog.open = false">取消</button>
        </footer>
      </div>
    </div>

    <div v-if="refillDialog.open" class="dialog-mask">
      <div class="dialog">
        <h3>重填生效日期（{{ refillDialog.label }}）</h3>
        <p class="dialog-desc">要求 YYYY-MM-DD 且落在变更类别允许的窗口内，冲突时以变更类别为准。</p>
        <label>
          生效日期
          <input v-model="refillDialog.value" placeholder="例如 2026-10-15" />
        </label>
        <p v-if="refillError" class="error-text">{{ refillError }}</p>
        <footer class="dialog-foot">
          <button class="btn primary" type="button" @click="confirmRefill">确认重填</button>
          <button class="btn ghost" type="button" @click="refillDialog.open = false">取消</button>
        </footer>
      </div>
    </div>

    <footer class="page-foot">
      <span>共 {{ total }} 条变更控制记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      <span v-if="noticeMessage" class="notice-text">{{ noticeMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  approveGroup,
  approveStage,
  currentStageOf,
  effectiveDateOf,
  evaluationCountOf,
  historyOf,
  needsDateRefill,
  progressText,
  rejectChanges,
  refillEffectiveDate,
  submitEvaluation,
  todayKey,
  type BatchItem,
} from '@/api/change-workflow'
import { downloadEntries, listEntries, moduleMeta } from '@/api/local-service'
import type { EntryRow } from '@/data/types'
import { useSessionStore } from '@/stores/session'

const meta = moduleMeta('changecontrol')
const store = useSessionStore()
const columns = ["变更编号", "变更类别", "涉及工序", "变更内容", "风险评估", "审批人", "生效日期", "变更状态"]
const statuses = ["待评估", "评估中", "已批准", "已拒绝"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const noticeMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const selectedIds = ref<number[]>([])
const batchItems = ref<BatchItem[]>([])

const evaluationDialog = reactive({ open: false, ids: [] as number[] })
const evaluationForm = reactive({ 评估人: '', 风险等级: '中', 评估意见: '' })
const evaluationError = ref('')
const refillDialog = reactive({ open: false, id: 0, label: '', value: '' })
const refillError = ref('')

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const stats = computed(() => {
  const monthKey = todayKey().slice(0, 7)
  const approvedThisMonth = rows.value.filter((row) =>
    historyOf(row).some((entry) => entry.动作 === '批准完成' && entry.时间.startsWith(monthKey)),
  ).length
  return [
    { label: '待评估变更', value: rows.value.filter((row) => String(row.status) === '待评估').length },
    { label: '评估中变更', value: rows.value.filter((row) => String(row.status) === '评估中').length },
    { label: '生效日期待重填', value: rows.value.filter((row) => needsDateRefill(row)).length },
    { label: '本月批准数', value: approvedThisMonth },
  ]
})

const allSelected = computed(
  () => rows.value.length > 0 && rows.value.every((row) => selectedIds.value.includes(Number(row.id))),
)
const okCount = computed(() => batchItems.value.filter((item) => item.ok).length)
const missingItems = computed(() => batchItems.value.filter((item) => item.kind === 'missing-field'))
const invalidDateItems = computed(() => batchItems.value.filter((item) => item.kind === 'invalid-date'))

function isSelected(id: number): boolean {
  return selectedIds.value.includes(id)
}

function toggleSelect(id: number) {
  selectedIds.value = isSelected(id)
    ? selectedIds.value.filter((item) => item !== id)
    : [...selectedIds.value, id]
}

function toggleSelectAll() {
  selectedIds.value = allSelected.value ? [] : rows.value.map((row) => Number(row.id))
}

function historyText(row: EntryRow): string {
  const history = historyOf(row)
  if (!history.length) {
    return '暂无流转记录'
  }
  return history.map((entry) => `${entry.时间} ${entry.动作}：${entry.说明}`).join('\n')
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '变更申请登记入口尚未接入审批流'
}

function openEvaluation(ids: number[]) {
  errorMessage.value = ''
  noticeMessage.value = ''
  evaluationError.value = ''
  evaluationDialog.ids = [...ids]
  evaluationDialog.open = true
}

function confirmEvaluation() {
  evaluationError.value = ''
  if (!evaluationForm.评估人.trim() || !evaluationForm.评估意见.trim()) {
    evaluationError.value = '评估人与评估意见必填，评估意见随风险评估表一并归档'
    return
  }
  const result = submitEvaluation(evaluationDialog.ids, { ...evaluationForm })
  batchItems.value = result.items
  evaluationDialog.open = false
  evaluationForm.评估意见 = ''
  selectedIds.value = []
  reload()
}

function approveOne(row: EntryRow) {
  errorMessage.value = ''
  noticeMessage.value = ''
  const result = approveStage(Number(row.id), currentStageOf(row), store.operator)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  noticeMessage.value = result.message
  reload()
}

function approveSelected() {
  errorMessage.value = ''
  noticeMessage.value = ''
  batchItems.value = approveGroup(selectedIds.value, store.operator).items
  selectedIds.value = []
  reload()
}

function rejectOne(row: EntryRow) {
  errorMessage.value = ''
  noticeMessage.value = ''
  batchItems.value = rejectChanges([Number(row.id)], store.operator).items
  reload()
}

function rejectSelected() {
  errorMessage.value = ''
  noticeMessage.value = ''
  batchItems.value = rejectChanges(selectedIds.value, store.operator).items
  selectedIds.value = []
  reload()
}

function openRefill(row: EntryRow) {
  errorMessage.value = ''
  noticeMessage.value = ''
  refillError.value = ''
  refillDialog.id = Number(row.id)
  refillDialog.label = String(row['变更编号'] ?? `#${row.id}`)
  refillDialog.value = effectiveDateOf(row)
  refillDialog.open = true
}

function confirmRefill() {
  refillError.value = ''
  const result = refillEffectiveDate(refillDialog.id, refillDialog.value)
  if (!result.ok) {
    refillError.value = result.message
    return
  }
  refillDialog.open = false
  noticeMessage.value = result.message
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '变更控制列表读取失败'
  }
}

onMounted(reload)
</script>
