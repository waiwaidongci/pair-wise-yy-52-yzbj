import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'

const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const outfile = root + '/node_modules/.store-test.mjs'

await build({
  entryPoints: [root + '/stores/operations.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile,
  alias: { '~': root },
  define: { 'import.meta.client': 'true' },
  external: ['pinia', 'vue'],
  banner: { js: 'import { ref, computed, reactive } from "vue"' },
})

const mem = new Map()
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
  clear: () => mem.clear(),
}
globalThis.confirm = () => true

const { createPinia, setActivePinia } = await import('pinia')
const { useOperationsStore } = await import(pathToFileURL(outfile).href)

setActivePinia(createPinia())
const store = useOperationsStore()

const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); process.exitCode = 1 } else console.log('PASS:', msg) }

assert(store.connection === '离线' && store.pendingRetry === 6, `初始断网且 6 项本地待提交（实际 ${store.pendingRetry}）`)
assert(store.pendingPermitIds.length === 3, `3 张许可待对账（实际 ${store.pendingPermitIds.length}）`)

store.markOnline()
assert(store.snapshotLoaded && store.connection === '在线', '线路恢复并装载调度端快照')

const first = store.reconcileNext()
assert(!!first && store.report.items.length === 1, `逐项对账 1 张（实际 ${store.report?.items.length}）`)
const firstId = first.permitId
const auditAfterFirst = store.audit.length

store.interruptReconcile()
const again = store.reconcileOne(firstId)
assert(again.permitId === firstId && store.report.items.length === 1, '重复提交已对账许可：跳过，不新增对账结果')
assert(store.audit.length === auditAfterFirst + 1, '中断动作只新增 1 条中断日志；已对账许可没有重复生成操作日志')

store.resumeReconcile()
assert(store.pendingPermitIds.length === 0 && store.reconcileDone, '续传后无待对账许可')
assert(store.report.items.length === 3, `三张许可均已对账（实际 ${store.report.items.length}）`)

const auditBefore = store.audit.length
store.resumeReconcile()
assert(store.audit.length === auditBefore, '队列为空时再次续传：不生成任何日志')

assert(store.conflicts.filter((c) => c.state === '待复核').length === 2, `两个冲突字段待复核（实际 ${store.conflicts.filter((c) => c.state === '待复核').length}）`)
const p018 = store.permits.find((p) => p.id === 'WP-260929-018')
assert(p018.acceptance.valid === false && p018.reconcileStatus === '验收失效待重新确认', '018 验收结论失效、状态待重新确认')

store.resolveConflict('WP-260929-021', 'isolationPoints.IP-412.state', 'dispatch')
const p021 = store.permits.find((p) => p.id === 'WP-260929-021')
assert(p021.isolationPoints.find((i) => i.id === 'IP-412').state === '待操作', '裁决后隔离点状态采用调度端值')
assert(p021.reviewRequired === false && p021.reconcileStatus === '已对账无争议', '021 冲突全部裁决后解除复核标记')

store.reconfirmAcceptance('WP-260929-018', '已核对调度签署与解除隔离，现场恢复后重新验收合格')
assert(p018.acceptance.valid === true, '018 验收重新确认后恢复有效')

assert(p021.steps.find((s) => s.id === 'ST-12').evidence === '五防校验单 FS-2207', '仅调度端补录的证据字段直接接收')
assert(p018.steps.find((s) => s.id === 'ST-03').done === true, '018 ST-03 现场记录被接收')

const ids = store.audit.map((a) => a.id)
assert(new Set(ids).size === ids.length, '全部操作日志 ID 无重复')
const rcLogs = store.audit.filter((a) => a.id.startsWith('AE-RC-'))
assert(new Set(rcLogs.map((l) => `${l.target}|${l.action}`)).size === rcLogs.length, '每张许可每类对账日志至多一条')
