export type PermitStatus = '待复核' | '待执行' | '执行中' | '待结束' | '待关闭' | '已完成'

export interface IsolationPoint {
  id: string
  device: string
  label: string
  type: '开关' | '刀闸' | '阀门' | '接地'
  state: '已隔离' | '待操作' | '已恢复'
}

export interface Permit {
  id: string
  title: string
  device: string
  crew: string
  owner: string
  window: string
  status: PermitStatus
  risk: '一级' | '二级' | '三级'
  isolationPoints: IsolationPoint[]
  steps: { id: string; text: string; done: boolean; owner: string; evidence?: string }[]
  revision: number
  reviewRequired: boolean
  /** 最近一次对账时的修订（历史数据缺失时按旧修订回填） */
  syncedRevision?: number
  /** 调度端已审批/签署/解除隔离后，现场验收结论失效待重新确认 */
  acceptanceInvalid?: boolean
  acceptanceInvalidReason?: string
  /** 对账后留待复核的冲突字段 */
  conflicts?: ReconcileConflict[]
  /** 断网期间新建、尚未与调度端对账的许可 */
  pendingSync?: boolean
}

export interface AuditEvent {
  id: string
  time: string
  actor: string
  action: string
  target: string
  detail: string
}

/** 断网期间端侧本地记录的待补传操作 */
export interface PendingOp {
  opId: string
  permitId: string
  type: 'step' | 'isolation' | 'status' | 'permit'
  baseRevision: number
  payload: Record<string, unknown>
  createdAt: string
}

/** 两边都碰过、未能合并的冲突字段，留待复核 */
export interface ReconcileConflict {
  id: string
  permitId: string
  /** 字段路径，如 status、steps.ST-03.done */
  field: string
  label: string
  local: unknown
  remote: unknown
  base?: unknown
}

/** 对账会话：可中断，恢复后只补未完成许可 */
export interface ReconcileSession {
  id: string
  startedAt: string
  status: '进行中' | '已完成' | '已中断'
  total: number
  /** 已完成逐项对账的许可 id */
  done: string[]
  conflicts: ReconcileConflict[]
  /** 验收结论失效、需重新确认的许可 id */
  invalidated: string[]
}
