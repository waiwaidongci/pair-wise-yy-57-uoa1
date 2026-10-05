import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { Batch, ChangeReceipt, ExecutionRecord, TestCase, TestStep } from './types'
import { devices, routes, seedBatches, seedCases, seedExecutions, seedReceipts } from './mock'

const INBOX_KEY = 'haizhou-inbox-v1'
const STATE_KEY = 'haizhou-state-v1'

let receiptSeq = 0
let failNextWrite = false

function now() {
  return new Date().toLocaleString('zh-CN', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hour12:false })
}

export const useTestStore = defineStore('interlocking', () => {
  const cases = ref<TestCase[]>(structuredClone(seedCases))
  const executions = ref<ExecutionRecord[]>(structuredClone(seedExecutions))
  const receipts = ref<ChangeReceipt[]>(structuredClone(seedReceipts))
  const batches = ref<Batch[]>(structuredClone(seedBatches))
  const routeList = ref(structuredClone(routes))
  const currentBatchId = ref('PB-G3')
  const baselineLocked = ref(false)
  const degraded = ref(false)
  const recoveryNote = ref('')
  const selectedCaseId = ref('TC-102')
  const selectedRouteIds = ref<string[]>(['R-02'])
  const connection = ref<'在线' | '重连中'>('在线')
  const pendingRetry = ref(0)
  const liveMessage = ref('执行进度已同步')

  const currentBatch = computed(() => batches.value.find((item) => item.id === currentBatchId.value) ?? batches.value[batches.value.length - 1])
  const pendingReceipts = computed(() => receipts.value.filter((item) => item.status === '待判'))
  const selectedCase = computed(() => cases.value.find((item) => item.id === selectedCaseId.value))
  const progress = computed(() => {
    const steps = cases.value.flatMap((item) => item.steps)
    return Math.round(steps.filter((step) => step.result !== '未执行').length / steps.length * 100)
  })
  const changedDevices = computed(() => [...new Set(receipts.value.filter((item) => item.status === '已入批').map((item) => item.summary))])
  const regressionScope = computed(() => {
    const ids = new Set(batches.value.flatMap((item) => item.scopeCaseIds))
    return cases.value.filter((item) => ids.has(item.id))
  })
  const canLock = computed(() => cases.value.every((item) => item.status === '通过') && pendingReceipts.value.length === 0 && !baselineLocked.value)

  function writeState() {
    localStorage.setItem(STATE_KEY, JSON.stringify({ cases:cases.value, executions:executions.value, batches:batches.value, routeList:routeList.value, currentBatchId:currentBatchId.value, baselineLocked:baselineLocked.value }))
  }
  function persist() {
    localStorage.setItem(INBOX_KEY, JSON.stringify(receipts.value))
    if (failNextWrite) {
      failNextWrite = false
      degraded.value = true
      liveMessage.value = '派生状态写入失败：回执已入收件箱，可据此恢复'
      return
    }
    writeState()
    degraded.value = false
  }
  function refreshCaseStatus(item: TestCase) {
    if (item.steps.some((step) => step.result === '失败')) item.status = '失败'
    else if (item.steps.every((step) => step.result === '通过')) item.status = '通过'
    else if (item.steps.some((step) => step.result !== '未执行')) item.status = '执行中'
    else item.status = '未执行'
  }
  function changedDeviceIds(receipt: ChangeReceipt) {
    if (receipt.kind === '进路关系变更' && receipt.routeId && receipt.routeDevicesAfter) {
      const before = routeList.value.find((item) => item.id === receipt.routeId)?.devices ?? []
      return [...before.filter((id) => !receipt.routeDevicesAfter!.includes(id)), ...receipt.routeDevicesAfter.filter((id) => !before.includes(id))]
    }
    return receipt.deviceId ? [receipt.deviceId] : []
  }
  function affectedRoutesFor(receipt: ChangeReceipt) {
    if (receipt.kind === '进路关系变更' && receipt.routeId) return [receipt.routeId]
    return devices.find((item) => item.id === receipt.deviceId)?.routeIds ?? []
  }
  function applyReceipt(receipt: ChangeReceipt) {
    const generation = receipt.generation ?? (currentBatch.value?.generation ?? 1) + 1
    const batchId = receipt.batchId ?? `PB-G${generation}`
    const changed = changedDeviceIds(receipt)
    if (receipt.kind === '进路关系变更' && receipt.routeId && receipt.routeDevicesAfter) {
      const route = routeList.value.find((item) => item.id === receipt.routeId)
      if (route) {
        route.devices = [...receipt.routeDevicesAfter]
        if (!route.affectedBy.includes(receipt.summary)) route.affectedBy.push(receipt.summary)
      }
    }
    const affectedRoutes = affectedRoutesFor(receipt)
    const scope = cases.value.filter((item) => item.routeIds.some((id) => affectedRoutes.includes(id))).map((item) => item.id)
    const invalidated: Batch['invalidatedSteps'] = []
    cases.value.forEach((item) => {
      if (!scope.includes(item.id)) return
      item.steps.forEach((step) => {
        if (!(step.deviceIds ?? []).some((id) => changed.includes(id))) return
        if (step.result !== '未执行') {
          const fromBatch = step.batchId ?? currentBatchId.value
          const fromGeneration = batches.value.find((entry) => entry.id === fromBatch)?.generation ?? generation - 1
          step.history = [...(step.history ?? []), { batchId:fromBatch, generation:fromGeneration, result:step.result, actual:step.actual, evidence:step.evidence }]
        }
        step.result = '未执行'
        step.actual = undefined
        step.evidence = undefined
        step.batchId = undefined
        step.invalidatedBy = batchId
        invalidated.push({ caseId:item.id, stepId:step.id })
      })
      refreshCaseStatus(item)
    })
    batches.value.forEach((item) => { if (item.status === '当前') item.status = '历史' })
    batches.value.push({ id:batchId, generation, status:'当前', receiptIds:[receipt.id], createdBy:receipt.sender, createdAt:receipt.receivedAt, affectedRouteIds:affectedRoutes, scopeCaseIds:scope, invalidatedSteps:invalidated, locked:false })
    currentBatchId.value = batchId
    baselineLocked.value = false
    receipt.status = '已入批'
    receipt.batchId = batchId
    receipt.generation = generation
  }
  function receiveReceipt(draft: Pick<ChangeReceipt, 'docNo' | 'sender' | 'kind' | 'summary'> & Partial<ChangeReceipt>) {
    const receipt: ChangeReceipt = {
      id:`RC-${Date.now().toString(36)}-${receiptSeq++}`,
      deviceId:draft.deviceId,
      routeId:draft.routeId,
      routeDevicesAfter:draft.routeDevicesAfter,
      baseBatchId:draft.baseBatchId ?? currentBatchId.value,
      receivedAt:now(),
      status:'待判',
      docNo:draft.docNo,
      sender:draft.sender,
      kind:draft.kind,
      summary:draft.summary,
    }
    if (receipts.value.some((item) => item.docNo === receipt.docNo)) {
      receipt.status = '重复拒收'
      receipts.value.push(receipt)
      liveMessage.value = `单号 ${receipt.docNo} 已接收过，重复补送只留首次结果`
      persist()
      return receipt
    }
    if (receipt.baseBatchId !== currentBatchId.value) {
      receipts.value.push(receipt)
      liveMessage.value = `单号 ${receipt.docNo} 基于 ${receipt.baseBatchId}，当前批次已推进，转入待判区`
      persist()
      return receipt
    }
    receipts.value.push(receipt)
    applyReceipt(receipt)
    liveMessage.value = `回执 ${receipt.docNo} 已入批 ${receipt.batchId}（G${receipt.generation}）`
    persist()
    return receipt
  }
  function resolvePending(receiptId: string, decision: '采纳' | '驳回') {
    const receipt = receipts.value.find((item) => item.id === receiptId)
    if (!receipt || receipt.status !== '待判') return
    if (decision === '驳回') {
      receipt.status = '已驳回'
      liveMessage.value = `单号 ${receipt.docNo} 已驳回`
    } else {
      applyReceipt(receipt)
      liveMessage.value = `待判单号 ${receipt.docNo} 已采纳入批 ${receipt.batchId}（G${receipt.generation}）`
    }
    persist()
  }
  function recoverFromInbox() {
    const missing = receipts.value.filter((item) => item.status === '已入批' && item.batchId && !batches.value.some((batch) => batch.id === item.batchId))
    if (!missing.length) {
      recoveryNote.value = '收件箱与批次一致，无需恢复'
      return
    }
    missing.forEach((receipt) => applyReceipt(receipt))
    degraded.value = false
    recoveryNote.value = `检测到写入失败，已从收件箱重放 ${missing.length} 张回执恢复批次`
    writeState()
  }
  function backfillGenerations() {
    executions.value.forEach((item) => {
      if (item.generation == null) {
        item.generation = 1
        item.backfilled = true
      }
    })
  }
  function restore() {
    const rawState = localStorage.getItem(STATE_KEY)
    if (rawState) {
      try {
        const state = JSON.parse(rawState)
        cases.value = state.cases
        executions.value = state.executions
        batches.value = state.batches
        routeList.value = state.routeList
        currentBatchId.value = state.currentBatchId
        baselineLocked.value = state.baselineLocked
      } catch {
        recoveryNote.value = '派生状态损坏，已按收件箱重建'
      }
    }
    const rawInbox = localStorage.getItem(INBOX_KEY)
    if (rawInbox) {
      try { receipts.value = JSON.parse(rawInbox) } catch { /* 保留种子回执 */ }
    }
    recoverFromInbox()
    backfillGenerations()
  }
  function nextDocNo() {
    const count = receipts.value.filter((item) => item.docNo.startsWith('海州-变更-2026-')).length + 41
    return `海州-变更-2026-${String(count).padStart(3, '0')}`
  }
  function simulateDuplicate() {
    const first = receipts.value.find((item) => item.status === '已入批')
    if (first) receiveReceipt({ docNo:first.docNo, sender:first.sender, kind:first.kind, deviceId:first.deviceId, summary:first.summary, routeId:first.routeId, routeDevicesAfter:first.routeDevicesAfter })
  }
  function simulateConcurrentEdit() {
    const base = currentBatchId.value
    receiveReceipt({ docNo:nextDocNo(), sender:'陆晨', kind:'设备变更', deviceId:'S-02', summary:'S-02 信号机灯丝单元更换', baseBatchId:base })
    receiveReceipt({ docNo:nextDocNo(), sender:'方瑜', kind:'进路关系变更', routeId:'R-02', routeDevicesAfter:['X-01','P-01','P-02','P-03','T-01','T-02','T-03','S-02'], summary:'R-02 进路关系变更：纳入 T-02 监督', baseBatchId:base })
  }
  function simulateWriteFailure() {
    failNextWrite = true
    receiveReceipt({ docNo:nextDocNo(), sender:'通号三队', kind:'设备变更', deviceId:'T-02', summary:'T-02 轨道电路发送器更换' })
  }
  function selectCase(id: string) { selectedCaseId.value = id; selectedRouteIds.value = cases.value.find((item) => item.id === id)?.routeIds ?? [] }
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
    step.batchId = currentBatchId.value
    step.invalidatedBy = undefined
    refreshCaseStatus(item)
    persist()
  }
  function startExecution() {
    const item = selectedCase.value
    if (!item) return
    item.status = '执行中'
    executions.value.unshift({ id:`EX-${Date.now().toString().slice(-6)}`, caseId:item.id, operator:'当前用户', startedAt:new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false}), snapshot:`v26.10 / CS-LEU-09 · ${currentBatchId.value}`, result:'执行中', evidence:[], generation:currentBatch.value?.generation ?? 1, batchId:currentBatchId.value })
    persist()
  }
  function updateLiveProgress(value: number) { liveMessage.value = value >= 100 ? '全部用例执行完成，等待审核锁定' : `实时同步：已完成 ${value}%`; if (value >= 100) { const active = executions.value.find((item) => item.result === '执行中'); if (active) { active.result = '失败'; active.finishedAt = new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false}) } } }
  function simulateDisconnect() { connection.value = '重连中'; pendingRetry.value += 1 }
  function retry() { connection.value = '在线'; pendingRetry.value = 0; liveMessage.value = '断线期间执行记录已补传' }
  function lockBaseline() {
    if (!canLock.value) return
    baselineLocked.value = true
    const batch = currentBatch.value
    if (batch) batch.locked = true
    persist()
  }
  restore()
  return { cases, executions, receipts, batches, routeList, currentBatchId, currentBatch, pendingReceipts, selectedCaseId, selectedRouteIds, selectedCase, progress, baselineLocked, connection, pendingRetry, liveMessage, changedDevices, regressionScope, canLock, degraded, recoveryNote, nextDocNo, receiveReceipt, resolvePending, recoverFromInbox, simulateDuplicate, simulateConcurrentEdit, simulateWriteFailure, selectCase, setStepResult, startExecution, updateLiveProgress, simulateDisconnect, retry, lockBaseline }
})
