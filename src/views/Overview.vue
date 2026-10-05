<script setup lang="ts">
import { computed, ref } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import { fetchStation } from '../api'
import { useTestStore } from '../store'
import { useExecutionSocket } from '../realtime'

const store = useTestStore()
const { data, isPending } = useQuery({ queryKey:['station'], queryFn:fetchStation })
useExecutionSocket((value) => store.updateLiveProgress(value), (state) => { store.connection = state })

// 模拟施工队回传变更回执
const receiptNo = ref('')
const deviceCode = ref('P-02')
const routeIds = ref<string[]>(['R-02'])
const changeType = ref<'更换' | '调整' | '新增' | '拆除'>('更换')
const description = ref('')

const routeOptions = ['R-01','R-02','R-03','R-04']
const deviceOptions = ['P-01','P-02','P-03','X-01','S-01','S-02','T-01','T-02','T-03']

function submitReceipt() {
  if (!receiptNo.value.trim()) return
  const desc = description.value.trim() || `${deviceCode.value} ${changeType.value}`
  store.acceptReceipt({
    receiptNo: receiptNo.value.trim(),
    deviceCode: deviceCode.value,
    changeType: changeType.value,
    routeIds: routeIds.value,
    description: desc,
    receivedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
    operator: '施工队',
  })
  receiptNo.value = ''
  description.value = ''
}

const stats = computed(() => [
  { label:'测试用例', value:store.cases.length, note:'关联 4 条基本进路' },
  { label:'执行进度', value:`${store.progress}%`, note:'实时同步正常' },
  { label:'失败 / 阻塞', value:store.cases.filter((item)=>['失败','阻塞'].includes(item.status)).length, note:'发布前必须闭环' },
  { label:'受影响回归范围', value:store.affectedCases.length, note:'设备变更自动推导' },
])
</script>

<template>
  <section class="page-head"><div><p class="eyebrow">版本升级与回归范围</p><h1>联锁测试回归总览</h1><p>根据道岔、信号机、轨道区段和进路关系，识别受影响用例并串联执行证据。</p></div><n-button type="primary" @click="$router.push('/station')">查看站场受影响区域</n-button></section>
  <n-spin :show="isPending">
    <div class="metrics"><article v-for="item in stats" :key="item.label" class="card metric"><span>{{item.label}}</span><strong>{{item.value}}</strong><small>{{item.note}}</small></article></div>

    <div class="grid-2">
      <article class="card">
        <div class="panel-head"><div><h2>本轮变更影响</h2><p>基于设备关系图自动计算</p></div><n-tag type="warning">{{data?.version}}</n-tag></div>
        <div v-for="change in store.changedDevices" :key="change" class=" change"><n-tag type="error">设备变更</n-tag><div><b>{{change}}</b><small>影响 {{store.affectedCases.length}} 条用例 · 需执行失败路径与敌对互锁</small></div></div>
        <n-alert type="warning" title="回归范围不能缩减" description="P-02 与 T-03 变更具有跨进路影响，只有版本控制负责人可审批范围例外。" />
      </article>

      <article class="card">
        <div class="panel-head"><div><h2>执行状态</h2><p>按用例和失败步骤汇总</p></div><n-tag>{{store.progress}}%</n-tag></div>
        <n-progress type="line" :percentage="store.progress" :height="12" />
        <div v-for="item in store.cases" :key="item.id" class="case-row" @click="store.selectCase(item.id); $router.push('/execution')">
          <div><b>{{item.id}} · {{item.name}}</b><small>{{item.steps.filter((step)=>step.result!=='未执行').length}}/{{item.steps.length}} 步骤 · 关联 {{item.routeIds.join(' / ')}}</small></div>
          <n-tag :type="item.status === '通过' ? 'success' : item.status === '失败' ? 'error' : item.status === '阻塞' ? 'warning' : 'info'">{{item.status}}</n-tag>
        </div>
      </article>
    </div>

    <!-- 当前批次 -->
    <article class="card batch-card">
      <div class="panel-head">
        <div><h2>当前批次</h2><p>总览、站场、执行页和报告都指向同一当前批次</p></div>
        <n-tag type="info" size="large">{{store.currentBatch?.generation ?? '无'}}</n-tag>
      </div>
      <div v-if="store.currentBatch" class="batch-meta">
        <div><span>批次号</span><b>{{store.currentBatch.id}}</b></div>
        <div><span>设备代次</span><b>{{store.currentBatch.generation}}</b></div>
        <div><span>基于</span><b>{{store.currentBatch.basedOnGeneration}}</b></div>
        <div><span>回执数</span><b>{{store.currentBatch.receipts.length}}</b></div>
        <div><span>影响设备</span><b>{{store.currentBatch.affectedDeviceCodes.join('、') || '—'}}</b></div>
        <div><span>影响进路</span><b>{{store.currentBatch.affectedRouteIds.join('、') || '—'}}</b></div>
      </div>
      <div v-if="store.currentBatch" class="receipt-list">
        <div v-for="r in store.currentBatch.receipts" :key="r.receiptNo" class="receipt-row">
          <n-tag size="small">{{r.changeType}}</n-tag>
          <div><b>{{r.receiptNo}} · {{r.deviceCode}}</b><small>{{r.description}} · {{r.receivedAt}} · {{r.operator}}</small></div>
        </div>
      </div>
    </article>

    <!-- 待判区 -->
    <article v-if="store.pendingBatch" class="card pending-card">
      <div class="panel-head">
        <div><h2>待判区</h2><p>两人同时修改范围时，后到内容进待判区；未处理完成不得锁基线</p></div>
        <n-tag type="warning" size="large">{{store.pendingBatch.generation}} 待判</n-tag>
      </div>
      <div class="batch-meta">
        <div><span>批次号</span><b>{{store.pendingBatch.id}}</b></div>
        <div><span>设备代次</span><b>{{store.pendingBatch.generation}}</b></div>
        <div><span>基于</span><b>{{store.pendingBatch.basedOnGeneration}}</b></div>
        <div><span>回执数</span><b>{{store.pendingBatch.receipts.length}}</b></div>
        <div><span>影响设备</span><b>{{store.pendingBatch.affectedDeviceCodes.join('、') || '—'}}</b></div>
        <div><span>影响进路</span><b>{{store.pendingBatch.affectedRouteIds.join('、') || '—'}}</b></div>
      </div>
      <div class="receipt-list">
        <div v-for="r in store.pendingBatch.receipts" :key="r.receiptNo" class="receipt-row">
          <n-tag size="small">{{r.changeType}}</n-tag>
          <div><b>{{r.receiptNo}} · {{r.deviceCode}}</b><small>{{r.description}} · {{r.receivedAt}} · {{r.operator}}</small></div>
        </div>
      </div>
      <n-alert type="warning" title="待判批次未处理完成，发布基线锁定被阻断" class="pending-alert" />
      <n-space>
        <n-button type="primary" @click="store.processPendingBatch">应用为当前依据</n-button>
        <n-button @click="store.rejectPendingBatch">驳回</n-button>
      </n-space>
    </article>

    <!-- 接收变更回执 -->
    <article class="card receipt-card">
      <div class="panel-head"><div><h2>接收变更回执</h2><p>施工队回传设备变更单据；同一单号重复补送只留首次结果</p></div></div>
      <n-form label-placement="top" class="receipt-form">
        <n-form-item label="单号"><n-input v-model:value="receiptNo" placeholder="如 BG-2610-03" /></n-form-item>
        <n-form-item label="设备代号"><n-select v-model:value="deviceCode" :options="deviceOptions.map(d=>({label:d,value:d}))" /></n-form-item>
        <n-form-item label="变更类型"><n-select v-model:value="changeType" :options="['更换','调整','新增','拆除'].map(t=>({label:t,value:t}))" /></n-form-item>
        <n-form-item label="关联进路"><n-select v-model:value="routeIds" multiple :options="routeOptions.map(r=>({label:r,value:r}))" /></n-form-item>
        <n-form-item label="说明"><n-input v-model:value="description" placeholder="可选" /></n-form-item>
        <n-form-item label=" "><n-button type="primary" @click="submitReceipt">接收回执</n-button></n-form-item>
      </n-form>
    </article>
  </n-spin>
</template>
