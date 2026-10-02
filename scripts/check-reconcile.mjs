import { createJiti } from 'jiti'
const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const jiti = await createJiti(import.meta.url, { alias: { '~': root } })
const { permits } = await jiti(root + '/utils/mock.ts')
const { dispatchSnapshot, seedOutbox } = await jiti(root + '/utils/dispatch.ts')
const { reconcilePermit } = await jiti(root + '/utils/reconcile.ts')

function clone(v) { return JSON.parse(JSON.stringify(v)) }
function run(permitId, now = '21:50') {
  const permit = clone(permits.find((p) => p.id === permitId))
  // apply local outbox (as store does at outage seed)
  for (const e of seedOutbox.filter((e) => e.permitId === permitId)) {
    const [g, id, k] = e.path.split('.')
    const holder = permit[g].find((r) => r.id === id)
    holder[k] = e.localValue
  }
  const locals = seedOutbox.filter((e) => e.permitId === permitId).map((e) => ({ id: e.id, path: e.path, fieldLabel: e.fieldLabel, localValue: e.localValue }))
  const snap = dispatchSnapshot.permits.find((s) => s.id === permitId)
  return reconcilePermit(permit, locals, snap, now)
}

const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); process.exitCode = 1 } else console.log('PASS:', msg) }

// 1) 018: 双方一致字段接收；冲突字段保留现场值；调度解除隔离 -> 验收失效
let r = run('WP-260929-018')
assert(r.item.accepted.length === 2, `018 接收 2 项一致/无争议字段（实际 ${r.item.accepted.length}）`)
assert(r.item.conflicts.length === 1 && r.item.conflicts[0].path === 'isolationPoints.IP-303.state', '018 叶轮机械锁状态列为冲突字段')
const p018 = r // permit mutates inside; check state via second run clone below
assert(p018.item.conflicts[0].localValue === '已隔离' && p018.item.conflicts[0].dispatchValue === '已恢复', '018 冲突保留现场值 vs 调度值')
const p018state = (() => { const p = clone(permits.find((x) => x.id === 'WP-260929-018')); return p })()
void p018state
assert(r.item.invalidReason && r.item.invalidReason.includes('解除隔离'), `018 验收失效原因：${r.item.invalidReason}`)
assert(r.logs.some((l) => l.action === '验收失效'), '018 生成验收失效日志')
assert(r.logs.length === new Set(r.logs.map((l) => l.id)).size, '018 日志 ID 唯一')

// 2) 021: 冲突 + 仅调度端补录字段直接接收
r = run('WP-260929-021')
assert(r.item.conflicts.length === 1 && r.item.conflicts[0].path === 'isolationPoints.IP-412.state', '021 接地刀闸冲突')
assert(r.item.dispatchOnly.length === 1 && r.item.dispatchOnly[0].path === 'steps.ST-12.evidence', '021 五防校验证据为调度端补录，直接接收')
assert(r.item.accepted.length === 1, `021 现场 ST-12 无争议接收（实际 ${r.item.accepted.length}）`)

// 3) 004: 调度端无记录 -> 全部现场接收
r = run('WP-260930-004')
assert(r.item.accepted.length === 1 && r.item.conflicts.length === 0 && !r.item.invalidReason, '004 调度端未改动，现场记录全部接收')

// 4) 幂等：同一许可二次对账产生固定 ID
const a = run('WP-260929-018', '21:51')
const b = run('WP-260929-018', '21:52')
assert(JSON.stringify(a.logs.map((l) => l.id)) === JSON.stringify(b.logs.map((l) => l.id)), '重复对账日志 ID 固定（store 按 ID 去重 => 不重复生成）')

// 5) 旧修订回填
const legacy = permits.find((p) => p.id === 'WP-260927-009')
assert(legacy.legacy === true && !!legacy.legacyIndex, '旧许可标记 legacy 并回填索引')
assert(legacy.isolationPoints.every((p) => p.device === 'WTG-01'), '旧隔离点缺失设备归属已回填')
assert(legacy.steps.every((s) => s.owner === '李骁'), '旧步骤缺失责任人已按负责人回填')
