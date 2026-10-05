import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import type { Batch, ChangeReceipt, ExecutionRecord, TestCase, TestStep } from './types'
import { seedBatches, seedCases, seedExecutions } from './mock'

const STORAGE_KEY = 'yy57-interlocking-draft-v1'
const RECEIPT_KEY = 'yy57-interlocking-receipts-v1'

/** 代次递增：G1 → G2 */
function nextGeneration(gen: string): string {
  const match = gen.match(/^G(\d+)$/)
  if (match) return `G${parseInt(match[1], 10) + 1}`
  return 'G1'
}

export const useTestStore = defineStore('interlocking', () => {
  const cases = ref<TestCase[]>(structuredClone(seedCases))
  const executions = ref<ExecutionRecord[]>(structuredClone(seedExecutions))
  const batches = ref<Batch[]>(structuredClone(seedBatches))
  const selectedCaseId = ref('TC-102')
  const selectedRouteIds = ref<string[]>(['R-02'])
  const baselineLocked = ref(false)
  const connection = ref<'在线' | '重连中'>('在线')
  const pendingRetry = ref(0)
  const liveMessage = ref('执行进度已同步')

  const currentBatchId = ref<string>(batches.value.find((b) => b.status === '当前')?.id ?? '')
  const pendingBatchId = ref<string | null>(batches.value.find((b) => b.status === '待判')?.id ?? null)

  const selectedCase = computed(() => cases.value.find((item) => item.id === selectedCaseId.value))
  const currentBatch = computed(() => batches.value.find((b) => b.id === currentBatchId.value) ?? null)
  const pendingBatch = computed(() => batches.value.find((b) => b.id === pendingBatchId.value) ?? null)

  const progress = computed(() => {
    const steps = cases.value.flatMap((item) => item.steps)
    return Math.round(steps.filter((step) => step.result !== '未执行').length / steps.length * 100)
  })

  /** 当前批次的设备变更描述 */
  const changedDevices = computed(() => currentBatch.value?.receipts.map((r) => r.description) ?? ['P-02 转辙机更换', 'T-03 绝缘节调整'])

  /** 当前批次影响的进路 → 推导受影响用例 */
  const affectedCases = computed(() => {
    const routeIds = currentBatch.value?.affectedRouteIds ?? ['R-02', 'R-04']
    return cases.value.filter((item) => item.routeIds.some((routeId) => routeIds.includes(routeId)))
  })

  function persist() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      cases: cases.value,
      executions: executions.value,
      batches: batches.value,
      currentBatchId: currentBatchId.value,
      pendingBatchId: pendingBatchId.value,
      baselineLocked: baselineLocked.value,
    }))
  }

  /** 回执立即落盘，用于写入失败后从已收下的回执恢复 */
  function persistReceipt(receipt: ChangeReceipt) {
    const raw = localStorage.getItem(RECEIPT_KEY)
    const receipts: ChangeReceipt[] = raw ? JSON.parse(raw) : []
    if (!receipts.some((r) => r.receiptNo === receipt.receiptNo)) {
      receipts.push(receipt)
      localStorage.setItem(RECEIPT_KEY, JSON.stringify(receipts))
    }
  }

  /** 写入失败后从已收下的回执恢复批次 */
  function recoverFromReceipts(): boolean {
    const raw = localStorage.getItem(RECEIPT_KEY)
    if (!raw) return false
    let receipts: ChangeReceipt[]
    try { receipts = JSON.parse(raw) } catch { return false }
    if (!receipts.length) return false
    const recovered: Batch[] = []
    let currentGen = 'G1'
    receipts.forEach((receipt) => {
      const gen = nextGeneration(currentGen)
      recovered.push({
        id: `B-REC-${receipt.receiptNo}`,
        generation: gen,
        status: '已归档',
        receipts: [receipt],
        affectedDeviceCodes: [receipt.deviceCode],
        affectedRouteIds: receipt.routeIds,
        basedOnGeneration: currentGen,
        createdAt: receipt.receivedAt,
        processedAt: receipt.receivedAt,
        operator: receipt.operator,
      })
      currentGen = gen
    })
    const last = recovered[recovered.length - 1]
    if (last) {
      last.status = '当前'
      batches.value = recovered
      currentBatchId.value = last.id
      pendingBatchId.value = null
      return true
    }
    return false
  }

  /** 旧执行缺代次时按首版补齐 */
  function backfillGenerations() {
    const firstGen = batches.value[0]?.generation ?? 'G1'
    cases.value.forEach((c) => { if (!c.generation) c.generation = firstGen })
    executions.value.forEach((e) => { if (!e.generation) e.generation = firstGen })
  }

  function restore() {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      try {
        const draft = JSON.parse(raw)
        if (draft.cases) cases.value = draft.cases
        if (draft.executions) executions.value = draft.executions
        if (draft.batches) batches.value = draft.batches
        if (draft.currentBatchId) currentBatchId.value = draft.currentBatchId
        if (draft.pendingBatchId !== undefined) pendingBatchId.value = draft.pendingBatchId
        if (draft.baselineLocked !== undefined) baselineLocked.value = draft.baselineLocked
      } catch {
        // 写入失败后从已收下的回执恢复
        recoverFromReceipts()
      }
    } else {
      // 无草稿时尝试从回执恢复
      recoverFromReceipts()
    }
    backfillGenerations()
  }

  function selectCase(id: string) {
    selectedCaseId.value = id
    selectedRouteIds.value = cases.value.find((item) => item.id === id)?.routeIds ?? []
  }

  function setStepResult(caseId: string, stepId: string, result: TestStep['result'], actual?: string) {
    if (baselineLocked.value) return
    const item = cases.value.find((entry) => entry.id === caseId)
    const step = item?.steps.find((entry) => entry.id === stepId)
    if (!item || !step) return
    if (step.dependency && item.steps.find((entry) => entry.id === step.dependency)?.result !== '通过') {
      liveMessage.value = `前置步骤 ${step.dependency} 未通过，禁止跳过`
      return
    }
    step.result = result
    step.actual = actual ?? step.actual
    step.generation = currentBatch.value?.generation ?? item.generation ?? 'G1'
    step.invalidated = false // 重算后清除失效标记
    item.status = item.steps.some((entry) => entry.result === '失败') ? '失败'
      : item.steps.every((entry) => entry.result === '通过') ? '通过'
      : '执行中'
    persist()
  }

  function startExecution() {
    const item = selectedCase.value
    if (!item) return
    item.status = '执行中'
    executions.value.unshift({
      id: `EX-${Date.now().toString().slice(-6)}`,
      caseId: item.id,
      operator: '当前用户',
      startedAt: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }),
      snapshot: 'v26.10 / CS-LEU-09',
      result: '执行中',
      evidence: [],
      generation: currentBatch.value?.generation ?? 'G1',
    })
    persist()
  }

  function updateLiveProgress(value: number) {
    liveMessage.value = value >= 100 ? '全部用例执行完成，等待审核锁定' : `实时同步：已完成 ${value}%`
    if (value >= 100) {
      const active = executions.value.find((item) => item.result === '执行中')
      if (active) {
        active.result = '失败'
        active.finishedAt = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
      }
    }
  }

  function simulateDisconnect() { connection.value = '重连中'; pendingRetry.value += 1 }
  function retry() { connection.value = '在线'; pendingRetry.value = 0; liveMessage.value = '断线期间执行记录已补传' }

  /**
   * 接收变更回执（幂等：同一单号重复补送只留首次结果）。
   * 设备代号或进路关系变化 → 生成新代次批次；
   * 两人同时修改时先到的批次成为当前依据，后到内容进待判区。
   */
  function acceptReceipt(receipt: ChangeReceipt): { duplicated: boolean; batchId?: string } {
    const exists = batches.value.some((b) => b.receipts.some((r) => r.receiptNo === receipt.receiptNo))
    if (exists) {
      liveMessage.value = `单号 ${receipt.receiptNo} 已收下，重复补送忽略`
      return { duplicated: true }
    }

    // 回执立即落盘，用于写入失败后恢复
    persistReceipt(receipt)

    const affectedRouteIds = [...new Set(receipt.routeIds)]
    const affectedDeviceCodes = [receipt.deviceCode]
    const currentGen = currentBatch.value?.generation ?? 'G1'
    const newGen = nextGeneration(currentGen)

    // 已有待判批次 → 后到内容进待判区（并入待判批次）
    const pending = batches.value.find((b) => b.status === '待判')
    if (pending) {
      pending.receipts.push(receipt)
      pending.affectedRouteIds = [...new Set([...pending.affectedRouteIds, ...affectedRouteIds])]
      pending.affectedDeviceCodes = [...new Set([...pending.affectedDeviceCodes, ...affectedDeviceCodes])]
      pending.generation = nextGeneration(pending.generation)
      liveMessage.value = `后到内容已进待判区（${pending.generation}），等待处理`
      persist()
      return { duplicated: false, batchId: pending.id }
    }

    // 创建新代次批次（初始为待判）
    const batch: Batch = {
      id: `B-${Date.now().toString(36)}`,
      generation: newGen,
      status: '待判',
      receipts: [receipt],
      affectedDeviceCodes,
      affectedRouteIds,
      basedOnGeneration: currentGen,
      createdAt: new Date().toISOString(),
      operator: receipt.operator,
    }
    batches.value.push(batch)
    pendingBatchId.value = batch.id
    liveMessage.value = `已收下回执 ${receipt.receiptNo}，批次 ${batch.generation} 待处理`
    persist()
    return { duplicated: false, batchId: batch.id }
  }

  /**
   * 仅让关联步骤的结论失效并重算，其他已核证据照原批次保留。
   * 关联步骤 = 用例进路与批次受影响进路有交集的步骤。
   */
  function invalidateAffectedSteps(batch: Batch) {
    const affectedRouteIds = new Set(batch.affectedRouteIds)
    cases.value.forEach((c) => {
      const caseAffected = c.routeIds.some((r) => affectedRouteIds.has(r))
      if (!caseAffected) return // 非关联用例，证据照原批次保留
      c.steps.forEach((step) => {
        if (step.result !== '未执行') {
          step.generation = c.generation ?? batch.basedOnGeneration // 保留取得结论时的代次
          step.invalidated = true
          step.result = '未执行' // 结论失效，待重算；actual/evidence 照原批次保留
        }
      })
      c.status = c.steps.some((s) => s.result === '失败') ? '失败'
        : c.steps.every((s) => s.result === '通过') ? '通过'
        : '执行中'
    })
  }

  /** 应用待判批次：先到的批次成为当前依据 */
  function applyBatch(batchId: string): boolean {
    const batch = batches.value.find((b) => b.id === batchId)
    if (!batch || batch.status !== '待判') return false

    const previousCurrent = batches.value.find((b) => b.status === '当前')
    if (previousCurrent) previousCurrent.status = '已归档'

    batch.status = '当前'
    batch.processedAt = new Date().toISOString()
    currentBatchId.value = batch.id
    pendingBatchId.value = null

    invalidateAffectedSteps(batch)

    // 用例与执行记录代次跟进
    cases.value.forEach((c) => { c.generation = batch.generation })
    executions.value.forEach((e) => { if (!e.generation) e.generation = batch.generation })

    liveMessage.value = `批次 ${batch.generation} 已成为当前依据`
    persist()
    return true
  }

  /** 处理待判区批次（应用后待判区清空，基线可锁） */
  function processPendingBatch(): boolean {
    if (!pendingBatchId.value) return false
    return applyBatch(pendingBatchId.value)
  }

  /** 驳回待判批次（不成为当前依据） */
  function rejectPendingBatch() {
    if (!pendingBatchId.value) return
    const batch = batches.value.find((b) => b.id === pendingBatchId.value)
    if (batch) {
      batch.status = '已归档'
      batch.note = (batch.note ?? '') + ' · 待判驳回'
    }
    pendingBatchId.value = null
    liveMessage.value = '待判批次已驳回'
    persist()
  }

  /** 锁定发布基线：待判批次未处理完成不得锁基线 */
  function lockBaseline(): boolean {
    if (pendingBatchId.value) {
      liveMessage.value = '待判批次未处理完成，不得锁定基线'
      return false
    }
    baselineLocked.value = true
    liveMessage.value = '发布基线已锁定'
    persist()
    return true
  }

  watch(cases, persist, { deep: true })
  restore()

  return {
    cases, executions, batches, selectedCaseId, selectedRouteIds, selectedCase,
    progress, baselineLocked, connection, pendingRetry, liveMessage,
    currentBatchId, pendingBatchId, currentBatch, pendingBatch,
    changedDevices, affectedCases,
    selectCase, setStepResult, startExecution, updateLiveProgress,
    simulateDisconnect, retry, lockBaseline,
    acceptReceipt, applyBatch, processPendingBatch, rejectPendingBatch,
    recoverFromReceipts, backfillGenerations,
  }
})