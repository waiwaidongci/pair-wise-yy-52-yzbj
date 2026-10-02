import { ref } from 'vue'
import { permits as seedPermits, auditEvents as seedAudit } from '~/utils/mock'
import type { AuditEvent, Permit } from '~/types'

/**
 * 调度端（调度台）持有的许可状态。
 * 断网期间调度端并非静止：审批、签署、解除隔离都可能发生，
 * 因此恢复后必须逐项对账，不能整份替换端侧记录。
 */
export const dispatchPermits = ref<Permit[]>(structuredClone(seedPermits))
export const dispatchAudit = ref<AuditEvent[]>(structuredClone(seedAudit))
export const dispatchRevision = ref(20)

/** 已处理过的端侧操作 opId —— 对账中断后重传不重复生成操作日志 */
export const appliedOpIds = ref<Set<string>>(new Set())

// —— 断网期间调度端操作 ——

// WP-260929-021：调度端复核通过（审批）
const p021 = dispatchPermits.value.find((p) => p.id === 'WP-260929-021')!
p021.status = '待执行'
p021.reviewRequired = false
p021.revision = 4
dispatchAudit.value.unshift({
  id: 'AE-D1', time: '18:12', actor: '赵清', action: '审批通过', target: 'WP-260929-021',
  detail: '调度端复核通过，同意执行',
})

// WP-260929-018：调度端签署工作票，并解除 IP-303 机械锁隔离
const p018 = dispatchPermits.value.find((p) => p.id === 'WP-260929-018')!
p018.status = '待关闭'
p018.revision = 6
p018.isolationPoints.find((p) => p.id === 'IP-303')!.state = '已恢复'
p018.steps.find((s) => s.id === 'ST-03')!.evidence = '调度端验电报告 V-11'
dispatchAudit.value.unshift({
  id: 'AE-D2', time: '18:20', actor: '李骁', action: '签署工作票', target: 'WP-260929-018',
  detail: '调度端签署，状态推进至待关闭',
})
dispatchAudit.value.unshift({
  id: 'AE-D3', time: '18:21', actor: '系统', action: '解除隔离', target: 'IP-303',
  detail: '叶轮机械锁已解除，现场验收需重新确认',
})
