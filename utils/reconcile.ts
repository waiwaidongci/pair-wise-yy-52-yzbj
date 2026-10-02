import type { Permit, ReconcileConflict } from '~/types'

/**
 * 对账合并：以「上次同步的基础修订」为基准，对端侧本地状态与调度端状态做三方合并。
 * 两边都碰过的许可不整份替换：只合并非冲突字段，同一字段两边都改且不一致时留待复核。
 */

const SCALAR_FIELDS = ['title', 'device', 'crew', 'owner', 'window', 'status', 'risk', 'reviewRequired'] as const

const FIELD_LABELS: Record<string, string> = {
  title: '作业名称',
  device: '设备',
  crew: '班组',
  owner: '负责人',
  window: '计划窗口',
  status: '许可状态',
  risk: '风险等级',
  reviewRequired: '复核标记',
  done: '步骤完成',
  text: '步骤内容',
  evidence: '证据',
  state: '隔离状态',
  label: '隔离点',
}

function eq(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a == null || b == null) return a == b
  return JSON.stringify(a) === JSON.stringify(b)
}

type ConflictSink = (permitId: string, path: string, label: string, local: unknown, remote: unknown, base: unknown) => void

function mergeById<T extends { id: string }>(
  baseArr: T[] | undefined,
  localArr: T[],
  remoteArr: T[],
  kind: 'steps' | 'isolationPoints',
  permitId: string,
  onConflict: ConflictSink,
): T[] {
  const baseMap = new Map((baseArr ?? []).map((item) => [item.id, item]))
  const localMap = new Map(localArr.map((item) => [item.id, item]))
  const remoteMap = new Map(remoteArr.map((item) => [item.id, item]))
  const ids = [...new Set([...localMap.keys(), ...remoteMap.keys()])]
  const fields = kind === 'steps' ? ['text', 'done', 'owner', 'evidence'] : ['device', 'label', 'type', 'state']
  const out: T[] = []
  for (const id of ids) {
    const lv = localMap.get(id)
    const rv = remoteMap.get(id)
    const bv = baseMap.get(id)
    if (lv && !rv) { out.push(structuredClone(lv)); continue }
    if (rv && !lv) { out.push(structuredClone(rv)); continue }
    if (!lv || !rv) continue
    const item: T = structuredClone(lv)
    for (const field of fields) {
      const lvv = (lv as Record<string, unknown>)[field]
      const rvv = (rv as Record<string, unknown>)[field]
      const bvv = bv ? (bv as Record<string, unknown>)[field] : undefined
      if (eq(lvv, rvv)) (item as Record<string, unknown>)[field] = lvv
      else if (eq(lvv, bvv)) (item as Record<string, unknown>)[field] = rvv
      else if (eq(rvv, bvv)) (item as Record<string, unknown>)[field] = lvv
      else {
        onConflict(permitId, `${kind}.${id}.${field}`, `${id} · ${FIELD_LABELS[field] ?? field}`, lvv, rvv, bvv)
        ;(item as Record<string, unknown>)[field] = lvv
      }
    }
    out.push(item)
  }
  return out
}

export function mergePermit(
  base: Permit | null,
  local: Permit,
  remote: Permit,
): { merged: Permit; conflicts: ReconcileConflict[] } {
  const conflicts: ReconcileConflict[] = []
  const merged: Permit = structuredClone(local)
  merged.conflicts = []
  const b = base ?? ({} as Partial<Permit>)

  const sink: ConflictSink = (permitId, path, label, lv, rv, bv) => {
    conflicts.push({
      id: `CF-${permitId}-${path}-${Math.random().toString(36).slice(2, 6)}`,
      permitId,
      field: path,
      label,
      local: lv,
      remote: rv,
      base: bv,
    })
  }

  for (const field of SCALAR_FIELDS) {
    const lv = local[field]
    const rv = remote[field]
    const bv = (b as Record<string, unknown>)[field]
    if (eq(lv, rv)) (merged as Record<string, unknown>)[field] = lv
    else if (eq(lv, bv)) (merged as Record<string, unknown>)[field] = rv
    else if (eq(rv, bv)) (merged as Record<string, unknown>)[field] = lv
    else {
      sink(merged.id, field, FIELD_LABELS[field] ?? field, lv, rv, bv)
      ;(merged as Record<string, unknown>)[field] = lv
    }
  }

  merged.steps = mergeById(base?.steps, local.steps, remote.steps, 'steps', merged.id, sink)
  merged.isolationPoints = mergeById(base?.isolationPoints, local.isolationPoints, remote.isolationPoints, 'isolationPoints', merged.id, sink)

  return { merged, conflicts }
}

/**
 * 验收结论失效判定：
 * 调度端已解除隔离，或已签署（状态推进至待关闭/已完成）时，
 * 端侧此前确认的隔离边界、验收结论先失效，需重新确认。
 */
export function detectInvalidation(
  base: Permit | null,
  local: Permit,
  merged: Permit,
  remote: Permit,
): { invalid: boolean; reason?: string } {
  for (const rp of remote.isolationPoints) {
    if (rp.state !== '已恢复') continue
    const bp = base?.isolationPoints.find((p) => p.id === rp.id)
    const lp = local.isolationPoints.find((p) => p.id === rp.id)
    if (bp?.state === '已隔离' || lp?.state === '已隔离') {
      return { invalid: true, reason: `调度端已解除「${rp.label}」隔离，现场验收结论需重新确认` }
    }
  }
  const signed = ['待关闭', '已完成']
  if (signed.includes(remote.status) && base && !signed.includes(base.status)) {
    const hasAcceptance = merged.steps.some((s) => s.done && /确认|验收/.test(s.text))
    if (hasAcceptance) return { invalid: true, reason: '调度端已签署工作票，现场验收结论需重新确认' }
  }
  return { invalid: false }
}
