import { defineStore } from 'pinia'
import type { AuditEvent, Permit, PendingOp, ReconcileConflict, ReconcileSession } from '~/types'
import { auditEvents as seedAudit, permits as seedPermits } from '~/utils/mock'

const STORAGE_KEY = 'yy52-permit-ops-v2'
const LEGACY_KEY = 'yy52-permit-ops-v1'

function clone<T>(v: T): T { return structuredClone(v) }
function nowTime() {
  return new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
}
function uuid() { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}` }

export const useOperationsStore = defineStore('operations', () => {
  const permits = ref<Permit[]>(clone(seedPermits))
  const audit = ref<AuditEvent[]>(clone(seedAudit))
  const connection = ref<'在线' | '重连中'>('在线')
  const pendingRetry = ref(0)
  const latestAlert = ref('18:00–20:00 LINE-A2 存在跨班组重叠作业')
  const loaded = ref(false)
  /** 断网期间本地记录、待恢复后补传的操作 */
  const pendingOps = ref<PendingOp[]>([])
  /** 对账会话（可中断，持久化） */
  const reconcileSession = ref<ReconcileSession | null>(null)
  /** 每个许可最近一次对账后的快照（三方合并的基准） */
  const syncedSnapshot = ref<Record<string, Permit>>({})

  function persist() {
    if (import.meta.client) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        permits: permits.value,
        audit: audit.value,
        pendingOps: pendingOps.value,
        reconcileSession: reconcileSession.value,
        syncedSnapshot: syncedSnapshot.value,
      }))
    }
  }

  /** 历史数据缺少原始字段时，按旧修订回填索引：以当前状态作为对账基准 */
  function backfillSyncIndex() {
    for (const permit of permits.value) {
      if (permit.pendingSync) continue
      if (permit.syncedRevision == null) permit.syncedRevision = permit.revision
      if (!syncedSnapshot.value[permit.id]) syncedSnapshot.value[permit.id] = clone(permit)
    }
  }

  function restore() {
    if (!import.meta.client || loaded.value) return
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const draft = JSON.parse(raw)
      permits.value = draft.permits ?? permits.value
      audit.value = draft.audit ?? audit.value
      pendingOps.value = draft.pendingOps ?? []
      reconcileSession.value = draft.reconcileSession ?? null
      syncedSnapshot.value = draft.syncedSnapshot ?? {}
    } else {
      // 兼容旧版本地数据
      const legacy = localStorage.getItem(LEGACY_KEY)
      if (legacy) {
        const draft = JSON.parse(legacy)
        permits.value = draft.permits ?? permits.value
        audit.value = draft.audit ?? audit.value
      }
    }
    backfillSyncIndex()
    pendingRetry.value = pendingOps.value.length
    loaded.value = true
  }

  function addAudit(actor: string, action: string, target: string, detail: string) {
    audit.value.unshift({ id: `AE-${uuid().slice(-8)}`, time: nowTime(), actor, action, target, detail })
    persist()
  }

  /** 断网期间现场操作本地记账；在线时直接执行，不进补传队列 */
  function enqueueOp(permitId: string, type: PendingOp['type'], payload: Record<string, unknown>) {
    const permit = permits.value.find((item) => item.id === permitId)
    pendingOps.value.push({
      opId: `OP-${uuid()}`,
      permitId,
      type,
      baseRevision: permit?.revision ?? 1,
      payload: { ...payload, actor: '当前用户' },
      createdAt: nowTime(),
    })
    pendingRetry.value = pendingOps.value.length
    persist()
  }

  function advancePermit(id: string) {
    const permit = permits.value.find((item) => item.id === id)
    if (!permit) return
    const flow: Record<string, Permit['status']> = { 待复核: '待执行', 待执行: '执行中', 执行中: '待结束', 待结束: '待关闭', 待关闭: '已完成' }
    const next = flow[permit.status]
    if (!next) return
    if (permit.status === '待复核' && permit.reviewRequired && !confirm('该许可存在待复核冲突，确认由值班负责人承担审批责任？')) return
    const from = permit.status
    permit.status = next
    permit.reviewRequired = false
    permit.revision += 1
    addAudit('当前用户', '流程推进', permit.id, `状态由“${from}”变更为“${next}”`)
    if (connection.value === '重连中') enqueueOp(permit.id, 'status', { from, to: next })
  }

  function toggleStep(permitId: string, stepId: string) {
    const permit = permits.value.find((item) => item.id === permitId)
    const step = permit?.steps.find((item) => item.id === stepId)
    if (!permit || !step) return
    const previous = permit.steps.filter((item) => item.done).length
    step.done = !step.done
    if (previous === 2 && permit.steps.filter((item) => item.done).length === 3 && permit.id === 'WP-260929-018') {
      latestAlert.value = 'WP-260929-018 检测到 LINE-A2 共用母线隔离点，需要复核'
      permit.reviewRequired = true
      permits.value.find((item) => item.id === 'WP-260929-021')!.reviewRequired = true
    }
    addAudit('当前用户', step.done ? '完成步骤' : '撤销步骤', `${permit.id} / ${step.id}`, step.text)
    if (connection.value === '重连中') enqueueOp(permit.id, 'step', { stepId, text: step.text, done: step.done })
  }

  /** 现场执行/解除隔离措施；断网时本地记账 */
  function togglePointState(permitId: string, pointId: string) {
    const permit = permits.value.find((item) => item.id === permitId)
    const point = permit?.isolationPoints.find((item) => item.id === pointId)
    if (!permit || !point) return
    const next = point.state === '已隔离' ? '已恢复' : '已隔离'
    point.state = next
    permit.revision += 1
    addAudit('当前用户', next === '已恢复' ? '解除隔离' : '执行隔离', `${permit.id} / ${point.id}`, `${point.label} → ${next}`)
    if (connection.value === '重连中') enqueueOp(permit.id, 'isolation', { pointId, label: point.label, state: next })
  }

  function addPermit(permit: Permit) {
    permit.pendingSync = connection.value === '重连中'
    permits.value.unshift(permit)
    addAudit('当前用户', '新建许可', permit.id, permit.title)
    if (connection.value === '重连中') enqueueOp(permit.id, 'permit', { title: permit.title })
  }

  function acceptAlert() {
    latestAlert.value = ''
    addAudit('值班负责人', '确认冲突', '跨班组重叠', '同意调整 LINE-A2 作业时间，不允许同时开工')
  }

  function markOffline() {
    connection.value = '重连中'
    addAudit('系统', '线路中断', '端侧通道', '现场操作改为本地记账，恢复后逐项对账补传')
    persist()
  }
  function markOnline() {
    connection.value = '在线'
    addAudit('系统', '线路恢复', '端侧通道', '开始与调度端逐项对账')
    persist()
  }

  /** 开始（或重新开始）对账：逐项比对，只补未完成许可 */
  async function startReconcile() {
    backfillSyncIndex()
    reconcileSession.value = {
      id: `RC-${uuid()}`,
      startedAt: nowTime(),
      status: '进行中',
      total: permits.value.length,
      done: [],
      conflicts: [],
      invalidated: [],
    }
    addAudit('系统', '对账开始', reconcileSession.value.id, '逐项比对端侧与调度端许可，冲突字段留待复核')
    persist()
    await continueReconcile()
  }

  async function continueReconcile() {
    if (!reconcileSession.value || reconcileSession.value.status !== '进行中') return
    for (const permit of [...permits.value]) {
      if (reconcileSession.value.done.includes(permit.id)) continue
      await reconcileOne(permit)
      if (reconcileSession.value.status === '已中断') break
    }
    if (reconcileSession.value.status === '进行中') {
      reconcileSession.value.status = '已完成'
      addAudit('系统', '对账完成', reconcileSession.value.id, '全部许可逐项比对完成，待复核冲突处理后关闭')
    }
    persist()
  }

  async function reconcileOne(permit: Permit) {
    const ops = pendingOps.value.filter((op) => op.permitId === permit.id)
    const base = syncedSnapshot.value[permit.id] ?? null
    try {
      const res = await $fetch('/api/dispatch/reconcile', {
        method: 'POST',
        body: { permitId: permit.id, base, local: permit, ops },
      })
      const idx = permits.value.findIndex((item) => item.id === permit.id)
      if (idx >= 0) permits.value[idx] = res.merged
      for (const conflict of res.conflicts as ReconcileConflict[]) {
        const exists = reconcileSession.value.conflicts.some((item) => item.permitId === conflict.permitId && item.field === conflict.field)
        if (!exists) reconcileSession.value.conflicts.push(conflict)
      }
      if (res.invalidated && !reconcileSession.value.invalidated.includes(permit.id)) {
        reconcileSession.value.invalidated.push(permit.id)
        addAudit('系统', '验收失效', permit.id, res.invalidReason ?? '调度端状态变化，验收结论需重新确认')
      }
      // 仅移除已被调度端接受的操作；重复提交的操作不重复生成日志
      const applied = new Set(res.appliedOps as string[])
      pendingOps.value = pendingOps.value.filter((op) => !applied.has(op.opId))
      for (const ev of res.serverAudit as AuditEvent[]) {
        if (!audit.value.some((item) => item.id === ev.id)) audit.value.unshift(ev)
      }
      syncedSnapshot.value[permit.id] = clone(res.merged)
      pendingRetry.value = pendingOps.value.length
      reconcileSession.value.done.push(permit.id)
      persist()
    } catch (error) {
      addAudit('系统', '对账失败', permit.id, String(error))
      persist()
    }
  }

  function interruptReconcile() {
    if (!reconcileSession.value || reconcileSession.value.status !== '进行中') return
    reconcileSession.value.status = '已中断'
    addAudit('系统', '对账中断', reconcileSession.value.id, '已完成部分保留；恢复后只补未完成许可，不重复生成操作日志')
    persist()
  }

  function applyFieldValue(permit: Permit, field: string, value: unknown) {
    if (field.includes('.')) {
      const [kind, itemId, sub] = field.split('.')
      const arr = kind === 'steps' ? permit.steps : permit.isolationPoints
      const item = arr.find((entry) => entry.id === itemId)
      if (item) (item as Record<string, unknown>)[sub!] = value
    } else {
      (permit as Record<string, unknown>)[field] = value
    }
  }

  /** 冲突字段裁决：保留端侧记录 或 采纳调度端记录 */
  function resolveConflict(permitId: string, field: string, choice: 'local' | 'remote') {
    const permit = permits.value.find((item) => item.id === permitId)
    const conflict = permit?.conflicts?.find((item) => item.field === field)
    if (!permit || !conflict) return
    if (choice === 'remote') applyFieldValue(permit, field, conflict.remote)
    permit.conflicts = permit.conflicts?.filter((item) => item.field !== field)
    if (reconcileSession.value) {
      reconcileSession.value.conflicts = reconcileSession.value.conflicts.filter((item) => !(item.permitId === permitId && item.field === field))
    }
    permit.reviewRequired = (permit.conflicts?.length ?? 0) > 0 || !!permit.acceptanceInvalid
    addAudit('值班负责人', '冲突裁决', `${permitId} / ${conflict.label}`, choice === 'local' ? '保留端侧记录' : '采纳调度端记录')
    syncedSnapshot.value[permitId] = clone(permit)
    persist()
  }

  /** 验收结论失效后重新确认 */
  function reconfirmAcceptance(permitId: string) {
    const permit = permits.value.find((item) => item.id === permitId)
    if (!permit) return
    permit.acceptanceInvalid = false
    permit.acceptanceInvalidReason = undefined
    permit.reviewRequired = (permit.conflicts?.length ?? 0) > 0
    addAudit('值班负责人', '验收重新确认', permit.id, '隔离措施与验收结论已逐项重新确认有效')
    syncedSnapshot.value[permitId] = clone(permit)
    persist()
  }

  function retryPending() { navigateTo('/reconcile') }

  restore()
  return {
    permits, audit, connection, pendingRetry, latestAlert, loaded,
    pendingOps, reconcileSession, syncedSnapshot,
    advancePermit, toggleStep, togglePointState, addPermit, acceptAlert,
    markOffline, markOnline, retryPending, restore,
    startReconcile, continueReconcile, interruptReconcile,
    resolveConflict, reconfirmAcceptance,
  }
})
