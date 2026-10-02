import type {
  AuditEvent,
  DispatchFieldChange,
  DispatchPermitSnapshot,
  FieldConflict,
  Permit,
  ReconcileItem,
} from '~/types'

/** 把 steps.ST-03.done 这类路径读写到许可对象上 */
function navigate(permit: Permit, path: string): { holder: Record<string, any>; key: string } | undefined {
  const [group, id, key] = path.split('.') as [string, string, string]
  if (group !== 'steps' && group !== 'isolationPoints') return undefined
  const list = permit[group] as Array<{ id: string }>
  const holder = list.find((item) => item.id === id)
  return holder ? { holder: holder as unknown as Record<string, any>, key } : undefined
}

export function readPermitField(permit: Permit, path: string): string | boolean | undefined {
  const target = navigate(permit, path)
  return target ? target.holder[target.key] : undefined
}

function writePermitField(permit: Permit, path: string, value: string | boolean) {
  const target = navigate(permit, path)
  if (target) target.holder[target.key] = value
}

export function formatValue(value: string | boolean): string {
  if (typeof value === 'boolean') return value ? '是' : '否'
  return value
}

/** 现场本地记录的操作日志按确定性 ID 生成，续传/重复对账时天然幂等 */
export function reconcileLogId(permitId: string, suffix: string): string {
  return `AE-RC-${permitId}-${suffix}`
}

export interface ReconcileOutcome {
  item: ReconcileItem
  /** 对账中产生的操作日志，ID 固定，store 层按 ID 去重 */
  logs: AuditEvent[]
}

/**
 * 对一张许可执行字段级对账：
 * - 仅调度端改过的字段 → 直接接收
 * - 双方都碰过且取值一致 → 无争议确认
 * - 双方都碰过但取值不同 → 保留现状，登记冲突字段待复核，不整份替换
 * - 调度端已审批/签署/解除隔离 → 验收结论失效，需重新确认
 */
export function reconcilePermit(
  permit: Permit,
  localPaths: { id: string; path: string; fieldLabel: string; localValue: string | boolean }[],
  snapshot: DispatchPermitSnapshot | undefined,
  now: string,
): ReconcileOutcome {
  const accepted: ReconcileItem['accepted'] = []
  const dispatchOnly: ReconcileItem['dispatchOnly'] = []
  const conflicts: FieldConflict[] = []
  const lifecycle: string[] = []
  const logs: AuditEvent[] = []

  function log(suffix: string, actor: string, action: string, detail: string) {
    logs.push({ id: reconcileLogId(permit.id, suffix), time: now, actor, action, target: permit.id, detail })
  }

  const localByPath = new Map(localPaths.map((entry) => [entry.path, entry]))

  if (snapshot) {
    // 调度端生命周期动作以调度端为准，但不覆盖端侧字段
    if (snapshot.approved) {
      permit.dispatchSignals = { ...permit.dispatchSignals, approved: snapshot.approved }
      lifecycle.push(`调度端已于 ${snapshot.approved.at} 由 ${snapshot.approved.by} 审批通过`)
    }
    if (snapshot.signed) {
      permit.dispatchSignals = { ...permit.dispatchSignals, signed: snapshot.signed }
      lifecycle.push(`调度端已于 ${snapshot.signed.at} 由 ${snapshot.signed.by} 完成签署`)
    }
    if (snapshot.isolationReleased?.length) {
      permit.dispatchSignals = { ...permit.dispatchSignals, isolationReleased: snapshot.isolationReleased }
      lifecycle.push(...snapshot.isolationReleased.map((r) => `调度端已于 ${r.at} 由 ${r.by} 解除隔离：${r.label}`))
    }
    if (snapshot.status) {
      permit.status = snapshot.status
      lifecycle.push(`许可状态按调度端更新为「${snapshot.status}」`)
    }
    permit.revision = snapshot.revision

    for (const [path, change] of Object.entries(snapshot.fields) as [string, DispatchFieldChange][]) {
      const local = localByPath.get(path)
      if (!local) {
        // 仅调度端碰过：直接接收调度值
        writePermitField(permit, path, change.value)
        dispatchOnly.push({ path, label: labelOf(permit, path), value: formatValue(change.value), by: change.by, at: change.at })
        continue
      }
      if (local.localValue === change.value) {
        // 双方都碰过且一致：接收（本来就是同值）
        writePermitField(permit, path, change.value)
        accepted.push({ entryId: local.id, label: local.fieldLabel, note: `端侧与调度端一致（${formatValue(change.value)}），已确认` })
        continue
      }
      // 双方都碰过且不同：冲突字段留待复核，现场值保留，不整份替换
      conflicts.push({
        permitId: permit.id,
        path,
        fieldLabel: local.fieldLabel,
        localValue: formatValue(local.localValue),
        dispatchValue: formatValue(change.value),
        dispatchBy: change.by,
        dispatchAt: change.at,
        state: '待复核',
      })
    }

    // 端侧碰过、调度端没有对应变更的字段：无争议，按现场记录接收
    for (const entry of localPaths) {
      if (entry.path in snapshot.fields) continue
      writePermitField(permit, entry.path, entry.localValue)
      accepted.push({ entryId: entry.id, label: entry.fieldLabel, note: `接收现场记录（${formatValue(entry.localValue)}），调度端无异议` })
    }
  } else {
    // 调度端没有该许可的任何记录：全部现场记录无争议接收
    for (const entry of localPaths) {
      writePermitField(permit, entry.path, entry.localValue)
      accepted.push({ entryId: entry.id, label: entry.fieldLabel, note: `接收现场记录（${formatValue(entry.localValue)}），调度端未改动该许可` })
    }
    permit.revision += 1
  }

  // 调度端已审批、签署或解除隔离：受影响的验收结论先失效并重新确认
  let invalidReason: string | undefined
  const moved = snapshot && (snapshot.approved || snapshot.signed || snapshot.isolationReleased?.length)
  if (moved && permit.acceptance?.valid) {
    invalidReason = [
      snapshot?.approved ? '调度端已重新审批' : '',
      snapshot?.signed ? '调度端已重新签署' : '',
      snapshot?.isolationReleased?.length ? '调度端已解除隔离' : '',
    ].filter(Boolean).join('、')
    permit.acceptance = { ...permit.acceptance, valid: false, invalidReason }
    lifecycle.push(`原验收结论「${permit.acceptance.conclusion}」已失效，需重新确认`)
    log('acceptance-invalid', '系统', '验收失效', `因${invalidReason}，原验收结论「${permit.acceptance.conclusion}」失效，待重新确认`)
  }

  permit.reviewRequired = conflicts.length > 0
  permit.reconcileStatus = invalidReason
    ? '验收失效待重新确认'
    : conflicts.length
      ? '部分字段待复核'
      : '已对账无争议'

  const resolvedCount = accepted.length + dispatchOnly.length
  if (accepted.length) log('accepted', '系统', '对账接收', `接收无争议字段 ${accepted.length} 项`)
  if (dispatchOnly.length) log('dispatch-only', '系统', '调度补录', `接收调度端补录字段 ${dispatchOnly.length} 项`)
  if (conflicts.length) log('conflict', '系统', '对账冲突', `${conflicts.length} 个字段端侧与调度端不一致，保留现场值并标记待复核`)
  if (resolvedCount === 0 && conflicts.length === 0) log('noop', '系统', '对账完成', '无字段变化')

  return {
    item: {
      permitId: permit.id,
      at: now,
      accepted,
      conflicts,
      dispatchOnly,
      lifecycle,
      invalidReason,
      logsAdded: logs.length,
    },
    logs,
  }
}

export function labelOf(permit: Permit, path: string): string {
  const [group, id, key] = path.split('.') as [string, string, string]
  const item = (permit[group] as Array<{ id: string; label?: string; text?: string }>)?.find((row) => row.id === id)
  const name = group === 'steps' ? item?.text : item?.label
  const keyName: Record<string, string> = { done: '完成情况', state: '状态', evidence: '证据' }
  return `${group === 'steps' ? '步骤' : '隔离点'}「${name ?? id}」${keyName[key] ?? key}`
}
