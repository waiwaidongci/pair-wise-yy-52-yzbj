export type PermitStatus = '待复核' | '待执行' | '执行中' | '待结束' | '待关闭' | '已完成'

export type ReconcileStatus = '本地待对账' | '已对账无争议' | '部分字段待复核' | '验收失效待重新确认'

export interface IsolationPoint {
  id: string
  device: string
  label: string
  type: '开关' | '刀闸' | '阀门' | '接地'
  state: '已隔离' | '待操作' | '已恢复'
}

export interface PermitStep {
  id: string
  text: string
  done: boolean
  owner: string
  evidence?: string
}

/** 验收结论：调度端在断网期间审批、签署或解除隔离时会被置为失效，需要重新确认 */
export interface AcceptanceConclusion {
  conclusion: string
  valid: boolean
  invalidReason?: string
  confirmedBy?: string
  confirmedAt?: string
}

/** 调度端在断网期间留下的审批 / 签署 / 解除隔离信号 */
export interface DispatchSignals {
  approved?: { by: string; at: string }
  signed?: { by: string; at: string }
  isolationReleased?: { pointId: string; label: string; at: string; by: string }[]
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
  steps: PermitStep[]
  revision: number
  reviewRequired: boolean
  acceptance?: AcceptanceConclusion
  dispatchSignals?: DispatchSignals
  reconcileStatus?: ReconcileStatus
  /** 旧修订历史数据按 r 版本回填的索引 */
  legacyIndex?: string
  legacy?: boolean
}

/** 旧修订数据可能缺字段，入库前统一回填 */
export interface PermitSeed {
  id: string
  title: string
  device: string
  crew: string
  owner: string
  window: string
  status: PermitStatus
  risk: Permit['risk']
  revision?: number
  reviewRequired?: boolean
  isolationPoints: Array<{ id: string; device?: string; label: string; type: IsolationPoint['type']; state: IsolationPoint['state'] }>
  steps: Array<{ id: string; text: string; done: boolean; owner?: string; evidence?: string }>
  acceptance?: AcceptanceConclusion
}

export type OutboxSyncState = '待提交' | '已接收' | '双方一致' | '冲突待复核' | '复核按现场' | '复核按调度'

/** 断网期间端侧本地记录的一条许可步骤或隔离措施 */
export interface OutboxEntry {
  id: string
  permitId: string
  /** 字段路径，如 steps.ST-03.done / isolationPoints.IP-412.state */
  path: string
  fieldLabel: string
  localValue: string | boolean
  recordedAt: string
  recordedBy: string
  sync: OutboxSyncState
}

export interface DispatchFieldChange {
  by: string
  at: string
  value: string | boolean
}

/** 一张许可在调度端的快照（断网期间调度端的动作） */
export interface DispatchPermitSnapshot {
  id: string
  revision: number
  status?: PermitStatus
  approved?: { by: string; at: string }
  signed?: { by: string; at: string }
  isolationReleased?: { pointId: string; label: string; at: string; by: string }[]
  fields: Record<string, DispatchFieldChange>
}

export interface DispatchSnapshot {
  generatedAt: string
  permits: DispatchPermitSnapshot[]
}

export interface FieldConflict {
  permitId: string
  path: string
  fieldLabel: string
  localValue: string
  dispatchValue: string
  dispatchBy: string
  dispatchAt: string
  state: '待复核' | '已解决'
}

export interface AcceptedField {
  entryId: string
  label: string
  note: string
}

export interface DispatchOnlyField {
  path: string
  label: string
  value: string
  by: string
  at: string
}

/** 一张许可的对账结果 */
export interface ReconcileItem {
  permitId: string
  at: string
  accepted: AcceptedField[]
  conflicts: FieldConflict[]
  dispatchOnly: DispatchOnlyField[]
  lifecycle: string[]
  invalidReason?: string
  logsAdded: number
}

export interface ReconcileReport {
  startedAt: string
  finishedAt?: string
  items: ReconcileItem[]
}

export interface AuditEvent {
  id: string
  time: string
  actor: string
  action: string
  target: string
  detail: string
}
