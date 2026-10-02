import { defineStore } from 'pinia'
import type {
  AuditEvent,
  FieldConflict,
  OutboxEntry,
  Permit,
  ReconcileItem,
  ReconcileReport,
} from '~/types'
import { auditEvents as seedAudit, permits as seedPermits } from '~/utils/mock'
import { dispatchSnapshot as seedSnapshot, seedOutbox } from '~/utils/dispatch'
import { reconcileLogId, reconcilePermit } from '~/utils/reconcile'

const STORAGE_KEY = 'yy52-permit-ops-v2'
const LEGACY_KEY = 'yy52-permit-ops-v1'

const FLOW: Record<string, Permit['status']> = { 待复核: '待执行', 待执行: '执行中', 执行中: '待结束', 待结束: '待关闭', 待关闭: '已完成' }

function nowHHMM() {
  return new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
}

/** 把 steps.ST-03.done 这类路径写到许可上 */
function writeField(permit: Permit, path: string, value: string | boolean) {
  const [group, id, key] = path.split('.')
  const list = permit[group as 'steps' | 'isolationPoints'] as Array<Record<string, unknown>>
  const holder = list.find((item) => item.id === id)
  if (holder) holder[key] = value
}

interface PersistedState {
  permits: Permit[]
  audit: AuditEvent[]
  outbox: OutboxEntry[]
  snapshotLoaded: boolean
  report: ReconcileReport | null
  conflicts: FieldConflict[]
  restoredOutage: boolean
}

export const useOperationsStore = defineStore('operations', () => {
  const permits = ref<Permit[]>(structuredClone(seedPermits))
  const audit = ref<AuditEvent[]>(structuredClone(seedAudit))
  const connection = ref<'离线' | '在线'>('离线')
  const latestAlert = ref('端侧网络中断：许可步骤与隔离措施已转本地记录，恢复后对账')
  const outbox = ref<OutboxEntry[]>([])
  const snapshotLoaded = ref(false)
  const report = ref<ReconcileReport | null>(null)
  const conflicts = ref<FieldConflict[]>([])
  const restoredOutage = ref(false)
  const loaded = ref(false)

  // 待对账许可：还有“待提交”本地记录且本周期尚未生成对账结果
  const pendingPermitIds = computed(() => {
    const done = new Set((report.value?.items ?? []).map((item) => item.permitId))
    const withLocal = new Set(outbox.value.filter((entry) => entry.sync === '待提交').map((entry) => entry.permitId))
    return [...withLocal].filter((id) => !done.has(id))
  })
  const pendingRetry = computed(() => outbox.value.filter((entry) => entry.sync === '待提交').length)
  const reconcileDone = computed(() => snapshotLoaded.value && pendingPermitIds.value.length === 0)

  function persist() {
    if (!import.meta.client) return
    const state: PersistedState = {
      permits: permits.value,
      audit: audit.value,
      outbox: outbox.value,
      snapshotLoaded: snapshotLoaded.value,
      report: report.value,
      conflicts: conflicts.value,
      restoredOutage: restoredOutage.value,
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  }

  /** 旧版本本地数据迁移：缺字段的许可经回填索引后仍能查询隔离措施与操作日志 */
  function migrateLegacy(draft: { permits?: Permit[]; audit?: AuditEvent[] }): PersistedState | undefined {
    if (!Array.isArray(draft.permits)) return undefined
    const migrated: PersistedState = {
      permits: draft.permits.map((permit) => ({
        ...permit,
        reviewRequired: permit.reviewRequired ?? false,
        revision: permit.revision ?? 1,
        legacy: permit.legacy ?? false,
        legacyIndex: permit.legacyIndex ?? `legacy-migrated:${permit.device}:${permit.id}`,
        isolationPoints: (permit.isolationPoints ?? []).map((point) => ({ ...point, device: point.device ?? permit.device })),
        steps: (permit.steps ?? []).map((step) => ({ ...step, owner: step.owner ?? permit.owner })),
      })),
      audit: Array.isArray(draft.audit) ? draft.audit : structuredClone(seedAudit),
      outbox: [],
      snapshotLoaded: false,
      report: null,
      conflicts: [],
      restoredOutage: false,
    }
    return migrated
  }

  /** addAudit 幂等：同 ID 操作日志（对账续传时）绝不重复生成 */
  function addAudit(actor: string, action: string, target: string, detail: string, id?: string) {
    const eventId = id ?? `AE-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    if (audit.value.some((event) => event.id === eventId)) return false
    audit.value.unshift({ id: eventId, time: nowHHMM(), actor, action, target, detail })
    persist()
    return true
  }

  /** 初始化检修断网场景：本地记录先落到端侧并改写本地许可 */
  function seedOutageState() {
    outbox.value = structuredClone(seedOutbox)
    for (const entry of outbox.value) {
      const permit = permits.value.find((item) => item.id === entry.permitId)
      if (permit) writeField(permit, entry.path, entry.localValue)
      permit && (permit.reconcileStatus = '本地待对账')
    }
    audit.value.unshift(
      { id: 'AE-OFF-1', time: '19:58', actor: '系统', action: '网络中断', target: '端侧通道', detail: '与调度端连接中断，许可步骤与隔离措施转为本地记录' },
      { id: 'AE-OFF-2', time: '20:12', actor: '系统', action: '本地记录', target: 'WP-260929-018', detail: '本地已记录验电接地、边界确认与叶轮机械锁隔离（3 项待提交）' },
      { id: 'AE-OFF-3', time: '21:18', actor: '系统', action: '本地记录', target: 'WP-260929-021', detail: '本地已记录 A2 进线五防校验与 17 号杆接地刀闸隔离（2 项待提交）' },
      { id: 'AE-OFF-4', time: '21:40', actor: '系统', action: '本地记录', target: 'WP-260930-004', detail: '本地已记录箱变 12 高压负荷开关锁定（1 项待提交）' },
    )
    restoredOutage.value = true
  }

  function restore() {
    if (!import.meta.client || loaded.value) return
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const draft = JSON.parse(raw) as PersistedState
      permits.value = draft.permits
      audit.value = draft.audit
      outbox.value = draft.outbox ?? []
      snapshotLoaded.value = draft.snapshotLoaded ?? false
      report.value = draft.report ?? null
      conflicts.value = draft.conflicts ?? []
      restoredOutage.value = draft.restoredOutage ?? false
      connection.value = snapshotLoaded.value ? '在线' : '离线'
      latestAlert.value = snapshotLoaded.value ? '' : latestAlert.value
    } else {
      const legacyRaw = localStorage.getItem(LEGACY_KEY)
      if (legacyRaw) {
        const migrated = migrateLegacy(JSON.parse(legacyRaw))
        if (migrated) {
          permits.value = migrated.permits
          audit.value = migrated.audit
        }
      }
      seedOutageState()
      persist()
    }
    loaded.value = true
  }

  function advancePermit(id: string) {
    const permit = permits.value.find((item) => item.id === id)
    if (!permit) return
    const next = FLOW[permit.status]
    if (!next) return
    if (permit.status === '待复核' && permit.reviewRequired && !confirm('该许可存在待复核冲突，确认由值班负责人承担审批责任？')) return
    const previous = permit.status
    permit.status = next
    permit.reviewRequired = false
    permit.revision += 1
    addAudit('当前用户', '流程推进', permit.id, `状态由“${previous}”变更为“${next}”`)
  }

  /** 记录一条端侧本地字段（步骤完成 / 隔离措施），离线时进入待提交队列 */
  function recordLocal(permitId: string, path: string, fieldLabel: string, localValue: string | boolean, recordedBy: string) {
    const permit = permits.value.find((item) => item.id === permitId)
    if (!permit) return
    writeField(permit, path, localValue)
    const time = '09-29 ' + nowHHMM()
    if (connection.value === '离线') {
      const existing = outbox.value.find((entry) => entry.permitId === permitId && entry.path === path)
      if (existing) {
        existing.localValue = localValue
        existing.recordedAt = time
        existing.sync = '待提交'
      } else {
        outbox.value.push({ id: `OB-${Date.now().toString().slice(-6)}`, permitId, path, fieldLabel, localValue, recordedAt: time, recordedBy, sync: '待提交' })
      }
      permit.reconcileStatus = '本地待对账'
      // 若该许可之前已对账，出现新本地记录后重新进入待对账（不回滚已生成日志）
      if (report.value) report.value.items = report.value.items.filter((item) => item.permitId !== permitId)
      addAudit(recordedBy, '本地记录', permitId, `${fieldLabel} → ${localValue === true ? '是' : localValue === false ? '否' : localValue}（线路恢复后对账）`)
    } else {
      addAudit(recordedBy, '现场确认', permitId, `${fieldLabel} → ${localValue === true ? '是' : localValue === false ? '否' : localValue}`)
    }
  }

  function toggleStep(permitId: string, stepId: string) {
    const permit = permits.value.find((item) => item.id === permitId)
    const step = permit?.steps.find((item) => item.id === stepId)
    if (!permit || !step) return
    const next = !step.done
    step.done = next
    recordLocal(permitId, `steps.${stepId}.done`, `步骤「${step.text}」完成情况`, next, step.owner)
  }

  function toggleIsolation(permitId: string, pointId: string) {
    const permit = permits.value.find((item) => item.id === permitId)
    const point = permit?.isolationPoints.find((item) => item.id === pointId)
    if (!permit || !point) return
    const next = point.state === '已隔离' ? '已恢复' : '已隔离'
    point.state = next
    recordLocal(permitId, `isolationPoints.${pointId}.state`, `隔离点「${point.label}」状态`, next, '当前用户')
  }

  function addPermit(permit: Permit) {
    permits.value.unshift(permit)
    addAudit('当前用户', '新建许可', permit.id, permit.title)
  }

  function acceptAlert() {
    latestAlert.value = ''
    addAudit('值班负责人', '确认冲突', '跨班组重叠', '同意调整 LINE-A2 作业时间，不允许同时开工')
  }

  function markOffline() {
    connection.value = '离线'
    latestAlert.value = '端侧网络中断：许可步骤与隔离措施已转本地记录，恢复后对账'
    persist()
  }

  /** 线路恢复：装载调度端快照，准备逐项对账（不自动提交） */
  function markOnline() {
    if (connection.value === '在线' && snapshotLoaded.value) return
    connection.value = '在线'
    latestAlert.value = ''
    if (!snapshotLoaded.value) {
      snapshotLoaded.value = true
      addAudit('系统', '线路恢复', '端侧通道', '与调度端重新连通，调度端快照已装载，等待逐项对账')
    }
    persist()
  }

  function retryPending() { markOnline() }

  function localEntriesOf(permitId: string) {
    return outbox.value
      .filter((entry) => entry.permitId === permitId)
      .map((entry) => ({ id: entry.id, path: entry.path, fieldLabel: entry.fieldLabel, localValue: entry.localValue }))
  }

  /**
   * 对账一张许可。已对账的许可直接跳过；重复提交不会重新生成操作日志。
   */
  function reconcileOne(permitId: string): ReconcileItem | undefined {
    if (!snapshotLoaded.value) return undefined
    const permit = permits.value.find((item) => item.id === permitId)
    if (!permit) return undefined
    if (report.value?.items.some((item) => item.permitId === permitId)) {
      return report.value.items.find((item) => item.permitId === permitId)
    }
    const localPaths = localEntriesOf(permitId)
    const snapshot = seedSnapshot.permits.find((item) => item.id === permitId)
    const { item, logs } = reconcilePermit(permit, localPaths, snapshot, nowHHMM())

    for (const log of logs) addAudit(log.actor, log.action, log.target, log.detail, log.id)

    // 回写端侧队列条目状态（幂等：再次处理同一许可时不会走到这里）
    for (const accepted of item.accepted) {
      const entry = outbox.value.find((row) => row.id === accepted.entryId)
      if (entry) entry.sync = accepted.note.includes('一致') ? '双方一致' : '已接收'
    }
    for (const conflict of item.conflicts) {
      const entry = outbox.value.find((row) => row.permitId === permitId && row.path === conflict.path)
      if (entry) entry.sync = '冲突待复核'
      if (!conflicts.value.some((row) => row.permitId === permitId && row.path === conflict.path)) {
        conflicts.value.push({ ...conflict })
      }
    }

    if (!report.value) report.value = { startedAt: nowHHMM(), items: [] }
    report.value.items.push(item)
    persist()
    return item
  }

  /** 逐项对账：每次只处理一张许可，可被“中断” */
  function reconcileNext(): ReconcileItem | undefined {
    const id = pendingPermitIds.value[0]
    return id ? reconcileOne(id) : undefined
  }

  /** 对账中断后续传：只补未完成许可，已完成的跳过，日志不重复 */
  function resumeReconcile() {
    let processed = 0
    while (pendingPermitIds.value.length > 0) {
      reconcileNext()
      processed += 1
    }
    if (report.value && pendingPermitIds.value.length === 0) report.value.finishedAt = nowHHMM()
    if (processed > 0) {
      addAudit('系统', '对账完成', '调度端通道', `续传补齐 ${processed} 张许可，未重复生成操作日志`, reconcileLogId('resume', String(report.value?.items.length ?? 0)))
    }
    persist()
  }

  function interruptReconcile() {
    addAudit('系统', '对账中断', '调度端通道', '对账在中断处暂停，再次提交将只补未完成许可')
  }

  /** 冲突复核裁决：按调度端或按现场，二选一并留痕 */
  function resolveConflict(permitId: string, path: string, choice: 'dispatch' | 'local') {
    const conflict = conflicts.value.find((item) => item.permitId === permitId && item.path === path && item.state === '待复核')
    const permit = permits.value.find((item) => item.id === permitId)
    if (!conflict || !permit) return
    const entry = outbox.value.find((row) => row.permitId === permitId && row.path === path)
    if (choice === 'dispatch') {
      writeField(permit, path, conflict.dispatchValue === '是' ? true : conflict.dispatchValue === '否' ? false : conflict.dispatchValue)
      if (entry) entry.sync = '复核按调度'
      addAudit('值班负责人', '冲突裁决', `${permitId} / ${path}`, `按调度端复核：采用「${conflict.dispatchValue}」（${conflict.dispatchBy}）`)
    } else {
      if (entry) writeField(permit, path, entry.localValue)
      if (entry) entry.sync = '复核按现场'
      addAudit('值班负责人', '冲突裁决', `${permitId} / ${path}`, `按现场复核：维持「${conflict.localValue}」，将向调度端回执说明`)
    }
    conflict.state = '已解决'
    if (!conflicts.value.some((item) => item.permitId === permitId && item.state === '待复核')) {
      permit.reviewRequired = false
      if (permit.reconcileStatus === '部分字段待复核') permit.reconcileStatus = '已对账无争议'
    }
    persist()
  }

  /** 重新确认失效的验收结论 */
  function reconfirmAcceptance(permitId: string, conclusion: string) {
    const permit = permits.value.find((item) => item.id === permitId)
    if (!permit || !permit.acceptance) return
    permit.acceptance = { conclusion, valid: true, confirmedBy: '值班负责人', confirmedAt: '09-29 ' + nowHHMM() }
    if (!permit.reviewRequired) permit.reconcileStatus = '已对账无争议'
    addAudit('值班负责人', '验收重新确认', permitId, `已核对调度端审批/签署/隔离状态，重新确认：${conclusion}`)
    persist()
  }

  function resetDemo() {
    permits.value = structuredClone(seedPermits)
    audit.value = structuredClone(seedAudit)
    report.value = null
    conflicts.value = []
    snapshotLoaded.value = false
    connection.value = '离线'
    latestAlert.value = '端侧网络中断：许可步骤与隔离措施已转本地记录，恢复后对账'
    seedOutageState()
    persist()
  }

  restore()
  return {
    permits,
    audit,
    connection,
    latestAlert,
    outbox,
    snapshotLoaded,
    report,
    conflicts,
    restoredOutage,
    pendingRetry,
    pendingPermitIds,
    reconcileDone,
    advancePermit,
    toggleStep,
    toggleIsolation,
    addPermit,
    acceptAlert,
    markOffline,
    markOnline,
    retryPending,
    reconcileOne,
    reconcileNext,
    resumeReconcile,
    interruptReconcile,
    resolveConflict,
    reconfirmAcceptance,
    resetDemo,
    restore,
  }
})
