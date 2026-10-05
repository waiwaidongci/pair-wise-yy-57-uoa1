<script setup lang="ts">
import { computed, reactive, watch } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import { fetchStation } from '../api'
import { devices } from '../mock'
import { useTestStore } from '../store'
import { useExecutionSocket } from '../realtime'

const store = useTestStore()
const { data, isPending } = useQuery({ queryKey:['station'], queryFn:fetchStation })
useExecutionSocket((value) => store.updateLiveProgress(value), (state) => { store.connection = state })

const form = reactive({ docNo:'', sender:'通号三队', kind:'设备变更' as '设备变更' | '进路关系变更', deviceId:'P-01', routeId:'R-02', routeDevicesAfter:[] as string[], summary:'' })
const deviceOptions = devices.map((item) => ({ label:`${item.id} · ${item.name}`, value:item.id }))
const routeOptions = computed(() => store.routeList.map((item) => ({ label:`${item.id} · ${item.name}`, value:item.id })))
watch(() => form.routeId, (id) => { form.routeDevicesAfter = [...(store.routeList.find((item) => item.id === id)?.devices ?? [])] }, { immediate:true })
watch([() => form.kind, () => form.deviceId, () => form.routeId], () => { form.summary = form.kind === '设备变更' ? `${form.deviceId} 设备变更` : `${form.routeId} 进路关系变更` }, { immediate:true })

function submitReceipt() {
  store.receiveReceipt({
    docNo:form.docNo.trim() || store.nextDocNo(),
    sender:form.sender || '通号三队',
    kind:form.kind,
    deviceId:form.kind === '设备变更' ? form.deviceId : undefined,
    routeId:form.kind === '进路关系变更' ? form.routeId : undefined,
    routeDevicesAfter:form.kind === '进路关系变更' ? [...form.routeDevicesAfter] : undefined,
    summary:form.summary,
  })
  form.docNo = ''
}

const stats = computed(() => [
  { label:'当前批次', value:`${store.currentBatch?.id ?? '-'} · G${store.currentBatch?.generation ?? '-'}`, note:`${store.currentBatch?.receiptIds.length ?? 0} 张回执 · 失效 ${store.currentBatch?.invalidatedSteps.length ?? 0} 步` },
  { label:'执行进度', value:`${store.progress}%`, note:'实时同步正常' },
  { label:'失败 / 阻塞', value:store.cases.filter((item)=>['失败','阻塞'].includes(item.status)).length, note:'发布前必须闭环' },
  { label:'受影响回归范围', value:store.regressionScope.length, note:'各批次受影响用例并集' },
])
const statusType = (status: string) => status === '已入批' ? 'success' : status === '待判' ? 'warning' : status === '已驳回' ? 'error' : 'default'
</script>

<template>
  <section class="page-head"><div><p class="eyebrow">版本升级与回归范围</p><h1>联锁测试回归总览</h1><p>变更回执、进路关系、用例、执行记录与基线按设备代次成批串联，各页面共用同一当前批次。</p></div><n-space><n-tag type="info">当前批次 {{store.currentBatch?.id}} · G{{store.currentBatch?.generation}}</n-tag><n-button type="primary" @click="$router.push('/station')">查看站场受影响区域</n-button></n-space></section>
  <n-alert v-if="store.degraded" type="error" title="派生状态写入失败" style="margin-bottom:12px"><template #default>已收下的回执在收件箱中完好，刷新页面或点击恢复即可重放。<n-button size="tiny" style="margin-left:8px" @click="store.recoverFromInbox">从收件箱恢复</n-button></template></n-alert>
  <n-alert v-if="store.recoveryNote" type="success" :title="store.recoveryNote" closable style="margin-bottom:12px" @close="store.recoveryNote=''" />
  <n-spin :show="isPending">
    <div class="metrics"><article v-for="item in stats" :key="item.label" class="card metric"><span>{{item.label}}</span><strong>{{item.value}}</strong><small>{{item.note}}</small></article></div>
    <div class="grid-2">
      <article class="card">
        <div class="panel-head"><div><h2>变更回执收件箱</h2><p>同一单号重复补送只留首次结果；基于旧批次的补单转入待判区</p></div><n-tag type="warning">{{data?.version}}</n-tag></div>
        <n-form label-placement="top" size="small">
          <div class="form-row"><n-form-item label="施工单号（幂等键）"><n-input v-model:value="form.docNo" :placeholder="`留空自动取号，如下一张 ${store.nextDocNo()}`" /></n-form-item><n-form-item label="施工队"><n-input v-model:value="form.sender" /></n-form-item><n-form-item label="变更类型"><n-select v-model:value="form.kind" :options="['设备变更','进路关系变更'].map((v) => ({ label:v, value:v }))" /></n-form-item></div>
          <div class="form-row"><n-form-item v-if="form.kind==='设备变更'" label="设备代号"><n-select v-model:value="form.deviceId" :options="deviceOptions" /></n-form-item><template v-else><n-form-item label="进路"><n-select v-model:value="form.routeId" :options="routeOptions" /></n-form-item><n-form-item label="变更后设备构成"><n-select v-model:value="form.routeDevicesAfter" multiple :options="deviceOptions" /></n-form-item></template><n-form-item label="变更内容"><n-input v-model:value="form.summary" /></n-form-item></div>
        </n-form>
        <n-space style="margin-bottom:12px"><n-button type="primary" @click="submitReceipt">接收回执</n-button><n-button @click="store.simulateDuplicate">模拟重复补送</n-button><n-button @click="store.simulateConcurrentEdit">模拟两人同时改范围</n-button><n-button @click="store.simulateWriteFailure">模拟写入失败</n-button></n-space>
        <div v-for="item in [...store.receipts].reverse()" :key="item.id" class="receipt-row"><div><b>{{item.docNo}} · {{item.summary}}</b><small>{{item.sender}} · {{item.receivedAt}} · 基于 {{item.baseBatchId}}<template v-if="item.batchId"> → {{item.batchId}}（G{{item.generation}}）</template></small></div><n-tag :type="statusType(item.status)">{{item.status}}</n-tag></div>
      </article>
      <div class="stack">
        <article class="card"><div class="panel-head"><div><h2>本轮变更影响</h2><p>基于设备关系图自动计算</p></div><n-tag type="warning">{{store.changedDevices.length}} 项变更</n-tag></div><div v-for="change in store.changedDevices" :key="change" class="change"><n-tag type="error">设备变更</n-tag><div><b>{{change}}</b><small>回归范围 {{store.regressionScope.length}} 条用例 · 仅关联步骤结论失效重算</small></div></div><n-alert type="warning" title="回归范围不能缩减" description="设备代号或进路关系变化时，仅关联步骤结论失效，其他已核证据照原批次保留。" /></article>
        <article class="card"><div class="panel-head"><div><h2>执行状态</h2><p>按用例和失败步骤汇总</p></div><n-tag>{{store.progress}}%</n-tag></div><n-progress type="line" :percentage="store.progress" :height="12" /><div v-for="item in store.cases" :key="item.id" class="case-row" @click="store.selectCase(item.id); $router.push('/execution')"><div><b>{{item.id}} · {{item.name}}</b><small>{{item.steps.filter((step)=>step.result!=='未执行').length}}/{{item.steps.length}} 步骤 · 关联 {{item.routeIds.join(' / ')}}</small></div><n-tag :type="item.status === '通过' ? 'success' : item.status === '失败' ? 'error' : item.status === '阻塞' ? 'warning' : 'info'">{{item.status}}</n-tag></div></article>
      </div>
    </div>
  </n-spin>
</template>
