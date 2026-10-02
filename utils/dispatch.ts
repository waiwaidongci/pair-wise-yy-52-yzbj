import type { DispatchSnapshot, OutboxEntry } from '~/types'

/**
 * 断网期间端侧本地记录的许可步骤与隔离措施。
 * 线路恢复后，这些条目与调度端快照逐项对账。
 */
export const seedOutbox: OutboxEntry[] = [
  { id: 'OB-001', permitId: 'WP-260929-018', path: 'steps.ST-03.done', fieldLabel: '步骤「验电、放电并装设接地线」完成情况', localValue: true, recordedAt: '09-29 20:05', recordedBy: '何岚', sync: '待提交' },
  { id: 'OB-002', permitId: 'WP-260929-018', path: 'steps.ST-04.done', fieldLabel: '步骤「全体作业人员确认隔离边界」完成情况', localValue: true, recordedAt: '09-29 20:10', recordedBy: '李骁', sync: '待提交' },
  { id: 'OB-003', permitId: 'WP-260929-018', path: 'isolationPoints.IP-303.state', fieldLabel: '隔离点「叶轮机械锁」状态', localValue: '已隔离', recordedAt: '09-29 20:12', recordedBy: '周野', sync: '待提交' },
  { id: 'OB-004', permitId: 'WP-260929-021', path: 'steps.ST-12.done', fieldLabel: '步骤「断开 A2 进线并完成五防校验」完成情况', localValue: true, recordedAt: '09-29 21:14', recordedBy: '孙禾', sync: '待提交' },
  { id: 'OB-005', permitId: 'WP-260929-021', path: 'isolationPoints.IP-412.state', fieldLabel: '隔离点「17 号杆接地刀闸」状态', localValue: '已隔离', recordedAt: '09-29 21:18', recordedBy: '谭勇', sync: '待提交' },
  { id: 'OB-006', permitId: 'WP-260930-004', path: 'steps.ST-22.done', fieldLabel: '步骤「断开高压负荷开关并锁定」完成情况', localValue: true, recordedAt: '09-29 21:40', recordedBy: '孙禾', sync: '待提交' },
]

/**
 * 调度端在线路恢复后提供的快照：断网期间调度端的审批、签署、
 * 解除隔离动作，以及调度端改过的字段。
 */
export const dispatchSnapshot: DispatchSnapshot = {
  generatedAt: '2026-09-29T21:45:00+08:00',
  permits: [
    {
      id: 'WP-260929-018',
      revision: 5,
      status: '待结束',
      signed: { by: '王峥（调度值班员）', at: '09-29 20:31' },
      isolationReleased: [
        { pointId: 'IP-303', label: '叶轮机械锁', at: '09-29 20:40', by: '王峥（调度值班员）' },
      ],
      fields: {
        // 与端侧记录一致：双方都确认完成
        'steps.ST-04.done': { by: '王峥（调度值班员）', at: '09-29 20:30', value: true },
        // 与端侧冲突：现场仍记录已隔离，调度端已办理解除隔离
        'isolationPoints.IP-303.state': { by: '王峥（调度值班员）', at: '09-29 20:40', value: '已恢复' },
      },
    },
    {
      id: 'WP-260929-021',
      revision: 3,
      status: '待执行',
      approved: { by: '王峥（调度值班员）', at: '09-29 21:30' },
      signed: { by: '王峥（调度值班员）', at: '09-29 21:32' },
      fields: {
        // 与端侧冲突：现场报告接地刀闸已隔离，调度端因五防校验未过保持待操作
        'isolationPoints.IP-412.state': { by: '王峥（调度值班员）', at: '09-29 21:35', value: '待操作' },
        // 仅调度端补录：端侧没碰过，直接接收
        'steps.ST-12.evidence': { by: '王峥（调度值班员）', at: '09-29 21:36', value: '五防校验单 FS-2207' },
      },
    },
  ],
}
