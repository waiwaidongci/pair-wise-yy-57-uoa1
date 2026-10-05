export type TestStatus = '未执行' | '执行中' | '通过' | '失败' | '阻塞'

export interface StationDevice {
  id: string
  name: string
  kind: '道岔' | '信号机' | '轨道区段'
  x: number
  y: number
  routeIds: string[]
}

export interface RouteRelation {
  id: string
  name: string
  color: string
  points: [number, number][]
  devices: string[]
  affectedBy: string[]
}

export interface StepArchive {
  batchId: string
  generation: number
  result: TestStep['result']
  actual?: string
  evidence?: string
}

export interface TestStep {
  id: string
  action: string
  expected: string
  dependency?: string
  deviceIds?: string[]
  result: '未执行' | '通过' | '失败'
  actual?: string
  evidence?: string
  batchId?: string
  invalidatedBy?: string
  history?: StepArchive[]
}

export interface TestCase {
  id: string
  name: string
  routeIds: string[]
  precondition: string
  version: string
  status: TestStatus
  steps: TestStep[]
  failureReason?: string
}

export interface ExecutionRecord {
  id: string
  caseId: string
  operator: string
  startedAt: string
  finishedAt?: string
  snapshot: string
  result: TestStatus
  evidence: string[]
  generation?: number
  batchId?: string
  backfilled?: boolean
}

export type ReceiptStatus = '已入批' | '重复拒收' | '待判' | '已驳回'

export interface ChangeReceipt {
  id: string
  docNo: string
  sender: string
  kind: '设备变更' | '进路关系变更'
  deviceId?: string
  summary: string
  routeId?: string
  routeDevicesAfter?: string[]
  baseBatchId: string
  receivedAt: string
  status: ReceiptStatus
  batchId?: string
  generation?: number
}

export interface Batch {
  id: string
  generation: number
  status: '当前' | '历史'
  receiptIds: string[]
  createdBy: string
  createdAt: string
  affectedRouteIds: string[]
  scopeCaseIds: string[]
  invalidatedSteps: { caseId: string; stepId: string }[]
  locked: boolean
}
