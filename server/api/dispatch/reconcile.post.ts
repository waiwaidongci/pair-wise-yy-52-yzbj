import { appliedOpIds, dispatchAudit, dispatchPermits, dispatchRevision } from '~/server/utils/dispatchStore'
import { detectInvalidation, mergePermit } from '~/utils/reconcile'
import type { AuditEvent, Permit, PendingOp } from '~/types'

let auditSeq = 0

function auditFromOp(op: PendingOp, permitId: string): AuditEvent | null {
  const time = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
  const actor = String(op.payload.actor ?? '端侧现场')
  const id = `AE-OP-${Date.now().toString(36)}-${auditSeq++}`
  switch (op.type) {
    case 'step':
      return { id, time, actor, action: op.payload.done ? '完成步骤' : '撤销步骤', target: `${permitId} / ${String(op.payload.stepId ?? '')}`, detail: String(op.payload.text ?? '') }
    case 'isolation':
      return { id, time, actor, action: op.payload.state === '已恢复' ? '解除隔离' : '执行隔离', target: `${permitId} / ${String(op.payload.pointId ?? '')}`, detail: `${String(op.payload.label ?? '')} → ${String(op.payload.state ?? '')}` }
    case 'status':
      return { id, time, actor, action: '流程推进', target: permitId, detail: `${String(op.payload.from ?? '')} → ${String(op.payload.to ?? '')}` }
    case 'permit':
      return { id, time, actor, action: '新建许可', target: permitId, detail: String(op.payload.title ?? '') }
    default:
      return null
  }
}

export default defineEventHandler(async (event) => {
  const body = await readBody<{ permitId: string; base: Permit | null; local: Permit; ops: PendingOp[] }>(event)
  const { permitId, base, local, ops } = body

  // 幂等：同一 opId 只处理一次，对账中断重传不重复生成操作日志
  const fresh = ops.filter((op) => !appliedOpIds.value.has(op.opId))
  const duplicates = ops.filter((op) => appliedOpIds.value.has(op.opId))

  let merged: Permit
  let conflicts = []
  let invalidated = false
  let invalidReason: string | undefined

  const remote = dispatchPermits.value.find((p) => p.id === permitId)
  if (!remote) {
    // 端侧断网期间新建的许可：调度端无记录，直接补录
    merged = structuredClone(local)
    merged.conflicts = []
    dispatchPermits.value.unshift(merged)
  } else {
    const result = mergePermit(base, local, remote)
    merged = result.merged
    conflicts = result.conflicts
    const inv = detectInvalidation(base, local, merged, remote)
    invalidated = inv.invalid
    invalidReason = inv.reason
    if (invalidated) {
      merged.acceptanceInvalid = true
      merged.acceptanceInvalidReason = invalidReason
      merged.reviewRequired = true
    }
    merged.conflicts = conflicts
    const idx = dispatchPermits.value.findIndex((p) => p.id === permitId)
    if (idx >= 0) dispatchPermits.value[idx] = merged
  }

  const newAudit: AuditEvent[] = fresh.map((op) => auditFromOp(op, permitId)).filter((x): x is AuditEvent => x !== null)
  dispatchAudit.value.unshift(...newAudit)
  fresh.forEach((op) => appliedOpIds.value.add(op.opId))
  dispatchRevision.value += 1

  return {
    merged,
    conflicts,
    invalidated,
    invalidReason,
    appliedOps: fresh.map((op) => op.opId),
    duplicateOps: duplicates.map((op) => op.opId),
    serverRevision: dispatchRevision.value,
    serverAudit: dispatchAudit.value,
  }
})
