<script setup lang="ts">
import { computed } from 'vue'
import { useTestStore } from '../store'

const store = useTestStore()
const ready = computed(() => store.cases.every((item) => item.status === '通过'))
const gateState = computed(() => {
  if (store.pendingReceipts.length) return { type:'warning' as const, title:'待判区未处理完成，不得锁定基线', desc:'后到的并发修改必须先采纳或驳回，才能以当前批次为依据锁定。' }
  if (ready.value) return { type:'success' as const, title:'全部用例已通过，可锁定', desc:'设备快照、执行证据和失败闭环均完整。' }
  return { type:'error' as const, title:'发布门禁未通过', desc:'存在失败、阻塞或未执行步骤，任何人员不得无痕跳过。' }
})
function exportPackage() {
  const batch = store.currentBatch
  const report = {
    station:'海州站 CS',
    version:'v26.10',
    batch:{ id:batch?.id, generation:batch?.generation, locked:store.baselineLocked },
    batches:store.batches.map((item) => ({ id:item.id, generation:item.generation, status:item.status, receipts:item.receiptIds.length, scope:item.scopeCaseIds, invalidatedSteps:item.invalidatedSteps, locked:item.locked })),
    receipts:store.receipts.map((item) => ({ docNo:item.docNo, summary:item.summary, status:item.status, batchId:item.batchId, generation:item.generation })),
    pending:store.pendingReceipts.map((item) => item.docNo),
    cases:store.cases.map((item) => ({ id:item.id, name:item.name, status:item.status, failureReason:item.failureReason, steps:item.steps.map((step) => ({ id:step.id, result:step.result, batchId:step.batchId, invalidatedBy:step.invalidatedBy, archived:step.history?.length ?? 0 })) })),
    executions:store.executions.map((item) => ({ ...item, generation:item.generation ?? 1 })),
    generatedAt:new Date().toISOString(),
  }
  const blob = new Blob([JSON.stringify(report,null,2)],{type:'application/json'})
  const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download=`联锁测试报告-${batch?.id ?? 'batch'}.json`; link.click(); URL.revokeObjectURL(link.href)
}
</script>

<template>
  <section class="page-head"><div><p class="eyebrow">发布门禁与历史基线</p><h1>基线锁定与测试报告</h1><p>待判区清空且全部用例通过后，才能以当前批次 {{store.currentBatch?.id}}（G{{store.currentBatch?.generation}}）锁定基线并导出报告。</p></div><n-space><n-tag type="info">当前批次 {{store.currentBatch?.id}} · G{{store.currentBatch?.generation}}</n-tag><n-button @click="exportPackage">导出测试报告</n-button><n-button type="primary" :disabled="!store.canLock" @click="store.lockBaseline">锁定发布基线</n-button></n-space></section>
  <n-alert :type="gateState.type" :title="gateState.title" :description="gateState.desc" style="margin-bottom:16px" />
  <div class="grid-2">
    <div class="stack">
      <article class="card"><div class="panel-head"><div><h2>待判区</h2><p>两人同时改范围时，后到内容在此等待裁决</p></div><n-tag :type="store.pendingReceipts.length?'warning':'success'">{{store.pendingReceipts.length}} 项</n-tag></div><n-empty v-if="!store.pendingReceipts.length" description="待判区为空，可以当前批次为依据锁定基线" /><div v-for="item in store.pendingReceipts" :key="item.id" class="gate"><div><b>{{item.docNo}} · {{item.summary}}</b><small>{{item.sender}} · {{item.receivedAt}} · 基于 {{item.baseBatchId}}（当前 {{store.currentBatchId}}）</small></div><n-space size="small"><n-button size="small" type="primary" @click="store.resolvePending(item.id,'采纳')">采纳入批</n-button><n-button size="small" @click="store.resolvePending(item.id,'驳回')">驳回</n-button></n-space></div></article>
      <article class="card"><div class="panel-head"><div><h2>发布门禁清单</h2><p>自动判断，不允许人工绕过</p></div><n-tag :type="ready?'success':'error'">{{ready?'可发布':'阻断'}}</n-tag></div><div v-for="item in store.cases" :key="item.id" class="gate"><div><b>{{item.id}} · {{item.name}}</b><small>{{item.failureReason || '执行记录完整'}}</small></div><n-tag :type="item.status==='通过'?'success':item.status==='失败'?'error':'warning'">{{item.status}}</n-tag></div></article>
    </div>
    <div class="stack">
      <article class="card"><div class="panel-head"><div><h2>批次时间线</h2><p>回执 → 进路关系 → 用例 → 执行 → 基线，按设备代次串联</p></div><n-tag>{{store.batches.length}} 批</n-tag></div><div v-for="item in [...store.batches].reverse()" :key="item.id" class="gate"><div><b>{{item.id}} · G{{item.generation}}<n-tag v-if="item.locked" size="tiny" type="success" style="margin-left:6px">已锁基线</n-tag></b><small>{{item.createdBy}} · {{item.createdAt}} · 回执 {{item.receiptIds.length}} 张 · 回归 {{item.scopeCaseIds.length}} 例 · 失效 {{item.invalidatedSteps.length}} 步</small></div><n-tag :type="item.status==='当前'?'info':'default'">{{item.status}}</n-tag></div><n-divider /><h3>基线状态</h3><n-result :status="store.baselineLocked ? 'success' : 'info'" :title="store.baselineLocked ? `${store.currentBatch?.id} 已锁定` : '等待全部用例通过'" :description="store.baselineLocked ? '报告与证据哈希已签章。' : '锁定后生成只读版本快照。'" /></article>
    </div>
  </div>
</template>
