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

export interface TestStep {
  id: string
  action: string
  expected: string
  dependency?: string
  result: '未执行' | '通过' | '失败'
  actual?: string
  evidence?: string
  /** 代次：结论在哪个设备代次下取得 */
  generation?: string
  /** 代次变更后结论失效标记（证据照原批次保留） */
  invalidated?: boolean
}

export interface TestCase {
  id: string
  name: string
  routeIds: string[]
  precondition: string
  version: string
  /** 设备代次 */
  generation?: string
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
  /** 设备代次：旧执行缺代次时按首版补齐 */
  generation?: string
}

/** 变更回执：施工队回传的设备变更单据 */
export interface ChangeReceipt {
  /** 单号（幂等键：同一单号重复补送只留首次结果） */
  receiptNo: string
  /** 设备代号 */
  deviceCode: string
  changeType: '更换' | '调整' | '新增' | '拆除'
  /** 关联进路关系 */
  routeIds: string[]
  description: string
  receivedAt: string
  operator: string
}

/** 批次：带设备代次的变更/进路/用例/执行/基线归集单元 */
export interface Batch {
  id: string
  /** 设备代次 */
  generation: string
  status: '当前' | '待判' | '已归档'
  receipts: ChangeReceipt[]
  affectedDeviceCodes: string[]
  affectedRouteIds: string[]
  basedOnGeneration: string
  createdAt: string
  processedAt?: string
  operator: string
  note?: string
}
