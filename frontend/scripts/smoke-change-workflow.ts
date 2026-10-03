/* 变更流转冒烟测试：node 环境无 localStorage，local-store 会退回内存种子数据。 */
import {
  approveGroup,
  approveStage,
  checkEffectiveDate,
  currentStageOf,
  effectiveDateOf,
  evaluationCountOf,
  needsDateRefill,
  progressOf,
  refillEffectiveDate,
  rejectChanges,
  submitEvaluation,
  supplierTodos,
  SUPPLIER_STAGE,
  todayKey,
} from '@/api/change-workflow'
import { listRows } from '@/data/local-store'

let failures = 0
function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    console.log(`  ✓ ${name}`)
  } else {
    failures += 1
    console.error(`  ✗ ${name} ${detail}`)
  }
}
function row(id: number) {
  const found = listRows('changecontrol').find((r) => Number(r.id) === id)
  if (!found) throw new Error(`row ${id} missing`)
  return found
}

console.log('1. 批量提交评估（7 条全勾，逐条给结果）')
const batch = submitEvaluation([1, 2, 3, 4, 5, 6, 7], { 评估人: 'QA主任', 风险等级: '中', 评估意见: '同意，按方案执行' })
const byId = new Map(batch.items.map((i) => [i.id, i]))
check('id1 正常推进到评估中', byId.get(1)?.kind === 'ok' && String(row(1).status) === '评估中')
check('id1 当前工序是第一节 配液', currentStageOf(row(1)) === '配液')
check('id1 评估次数=1', evaluationCountOf(row(1)) === 1)
check('id1 附了风险评估表', String(row(1)['风险评估表']).includes('QA主任'))
check('id2 缺类别被单独拎出', byId.get(2)?.kind === 'missing-field' && String(row(2).status) === '待评估')
check('id3 缺风险评估被单独拎出', byId.get(3)?.kind === 'missing-field')
check('id4 紧急变更日期在未来→打回重填', byId.get(4)?.kind === 'invalid-date' && needsDateRefill(row(4)))
check('id5 非法日期 2026-13-01→打回重填', byId.get(5)?.kind === 'invalid-date' && needsDateRefill(row(5)))
check('id6 已评估过→重复只计一次', byId.get(6)?.kind === 'duplicate' && evaluationCountOf(row(6)) === 1)
check('id7 已批准也算重复评估→只计一次', byId.get(7)?.kind === 'duplicate' && String(row(7).status) === '已批准')

console.log('2. 重复评估只算一次')
const again = submitEvaluation([1], { 评估人: 'QA主任', 风险等级: '高', 评估意见: '换个意见再评' })
check('再次提交返回 duplicate', again.items[0]?.kind === 'duplicate')
check('评估次数仍是 1', evaluationCountOf(row(1)) === 1)
check('风险评估表没被覆盖', String(row(1)['风险评估表']).includes('"风险等级":"中"'))

console.log('3. 一节一节推进，越级挡回')
const jump = approveStage(1, '灌装', 'QA主任')
check('跳过配液直接审灌装被挡回', !jump.ok && jump.message.includes('越级'))
const step1 = approveStage(1, '配液', 'QA主任')
check('审当前节 配液 通过', step1.ok && progressOf(row(1)) === 1 && currentStageOf(row(1)) === '灌装')
check('状态仍是评估中（没跳终态）', String(row(1).status) === '评估中')

console.log('4. 整组批准（逐节走完）')
const group = approveGroup([1, 2], 'QA主任')
const g1 = group.items.find((i) => i.id === 1)
const g2 = group.items.find((i) => i.id === 2)
check('id1 逐节审完→已批准', g1?.ok === true && String(row(1).status) === '已批准' && row(1).pending === false)
check('id2 待评估直接批准属越级被挡回', g2?.kind === 'blocked' && g2.message.includes('越级'))

console.log('5. 状态落到供应商审计待办，生效日期两处同一份')
const todos = supplierTodos()
check('待办里有 CHAN-0006', todos.some((t) => t.变更编号 === 'CHAN-0006'))
const todo6 = todos.find((t) => t.id === 6)
check('待办生效日期=变更记录上的生效日期', todo6?.生效日期 === effectiveDateOf(row(6)) && todo6?.生效日期 === '2026-11-15')
const auditPass = approveStage(6, SUPPLIER_STAGE, '审计员')
check('供应商审计这节通过后进入灌装', auditPass.ok && currentStageOf(row(6)) === '灌装')
check('待办随之消失', !supplierTodos().some((t) => t.id === 6))

console.log('6. 生效日期打回重填')
const badRefill = refillEffectiveDate(4, '2026-12-31')
check('紧急变更填未来日期仍被打回', !badRefill.ok)
const goodRefill = refillEffectiveDate(4, todayKey())
check('紧急变更填当日通过', goodRefill.ok && !needsDateRefill(row(4)) && effectiveDateOf(row(4)) === todayKey())
const pastRefill = refillEffectiveDate(5, '2020-01-01')
check('一般变更追溯生效被打回', !pastRefill.ok)
const fmtRefill = refillEffectiveDate(5, '2026-02-30')
check('不存在的日历日被打回', !fmtRefill.ok)
const okRefill = refillEffectiveDate(5, '2026-10-20')
check('合法日期重填通过，可重新评估', okRefill.ok && !needsDateRefill(row(5)))
const reEval = submitEvaluation([5], { 评估人: 'QA主任', 风险等级: '低', 评估意见: '重填后评估' })
check('重填后可正常提交评估', reEval.items[0]?.kind === 'ok')

console.log('7. 整组退回')
const rejected = rejectChanges([2, 3, 7], 'QA主任')
const r2 = rejected.items.find((i) => i.id === 2)
const r7 = rejected.items.find((i) => i.id === 7)
check('待评估可退回→已拒绝', r2?.ok === true && String(row(2).status) === '已拒绝' && row(2).abnormal === true)
check('已批准不能退回', r7?.ok === false)

console.log('8. 类别与日期冲突裁定（以变更类别为准）')
check('重大变更 10 天后生效→冲突', !checkEffectiveDate('重大变更', offsetDate(10)).ok)
check('重大变更 30 天后生效→合法', checkEffectiveDate('重大变更', offsetDate(30)).ok)
check('紧急变更 明天生效→冲突', !checkEffectiveDate('紧急变更', offsetDate(1)).ok)
check('一般变更 昨天生效→冲突', !checkEffectiveDate('一般变更', offsetDate(-1)).ok)
check('一般变更 今天生效→合法', checkEffectiveDate('一般变更', todayKey()).ok)

function offsetDate(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
