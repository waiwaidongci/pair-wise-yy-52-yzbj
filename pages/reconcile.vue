<script setup lang="ts">
import { useOperationsStore } from '~/stores/operations'

const store = useOperationsStore()

const online = computed(() => store.connection === '在线')
const session = computed(() => store.reconcileSession)
const running = computed(() => session.value?.status === '进行中')
const totalConflicts = computed(() => store.permits.reduce((sum, p) => sum + (p.conflicts?.length ?? 0), 0))
const totalInvalidated = computed(() => store.permits.filter((p) => p.acceptanceInvalid).length)
const progress = computed(() => (session.value ? Math.round((session.value.done.length / session.value.total) * 100) : 0))

const pendingOpsByPermit = computed(() => {
  const map: Record<string, number> = {}
  for (const op of store.pendingOps) map[op.permitId] = (map[op.permitId] ?? 0) + 1
  return map
})

type RowStatus = '未开始' | '已完成' | '待复核' | '已中断'
function rowStatus(permitId: string): RowStatus {
  const permit = store.permits.find((p) => p.id === permitId)
  if (permit?.conflicts?.length || permit?.acceptanceInvalid) return '待复核'
  if (session.value?.done.includes(permitId)) return '已完成'
  if (session.value?.status === '已中断') return '已中断'
  return '未开始'
}
const rowColor: Record<RowStatus, 'gray' | 'green' | 'red' | 'amber'> = {
  未开始: 'gray', 已完成: 'green', 待复核: 'red', 已中断: 'amber',
}

const opTypeLabel: Record<string, string> = { step: '步骤', isolation: '隔离措施', status: '状态推进', permit: '新建许可' }

const conflictRows = computed(() =>
  store.permits.flatMap((p) => (p.conflicts ?? []).map((c) => ({ permit: p, conflict: c }))),
)
const invalidatedRows = computed(() => store.permits.filter((p) => p.acceptanceInvalid))

function valueText(value: unknown): string {
  if (value === undefined || value === null || value === '') return '（无）'
  if (typeof value === 'boolean') return value ? '是' : '否'
  return String(value)
}
</script>

<template>
  <div class="page">
    <div class="head">
      <div>
        <p class="eyebrow">离线对账 · 逐项补传</p>
        <h1 class="page-title">断网恢复对账台</h1>
        <p class="muted">端侧断网期间许可步骤与隔离措施本地记账；线路恢复后与调度端逐项对账。两边都碰过的许可不整份替换，只合并不冲突内容，冲突字段留待复核；调度端已审批、签署或解除隔离的，受影响验收结论先失效重新确认。</p>
      </div>
      <div class="inline wrap">
        <UButton v-if="online" color="gray" variant="outline" icon="i-heroicons-wifi" @click="store.markOffline">模拟断网</UButton>
        <UButton v-else color="amber" variant="soft" icon="i-heroicons-wifi" @click="store.markOnline">恢复线路</UButton>
        <UButton v-if="!running" color="primary" icon="i-heroicons-arrow-path" :disabled="!online" @click="session?.status === '已中断' ? store.continueReconcile() : store.startReconcile()">
          {{ session?.status === '已中断' ? '继续对账（只补未完成许可）' : '开始逐项对账' }}
        </UButton>
        <UButton v-else color="red" variant="soft" icon="i-heroicons-pause-circle" @click="store.interruptReconcile">中断对账</UButton>
      </div>
    </div>

    <UAlert v-if="!online" color="amber" variant="soft" icon="i-heroicons-exclamation-triangle" title="端侧断网" description="现场操作将记入本地待补传队列，不影响现场作业；线路恢复后点击“恢复线路”再开始对账。" class="mb-4" />

    <section class="grid metrics">
      <article class="panel metric"><span>待补传操作</span><strong>{{ store.pendingOps.length }}</strong><small>对账中断后只补未完成项</small></article>
      <article class="panel metric"><span>待复核冲突</span><strong class="danger">{{ totalConflicts }}</strong><small>两边同字段改动，不得整份替换</small></article>
      <article class="panel metric"><span>验收结论失效</span><strong class="danger">{{ totalInvalidated }}</strong><small>调度端审批/签署/解除隔离触发</small></article>
      <article class="panel metric"><span>对账进度</span><strong>{{ session ? `${session.done.length}/${session.total}` : '—' }}</strong><small>{{ session?.status === '进行中' ? '逐项比对中' : session?.status === '已中断' ? '已中断，可续传' : session?.status === '已完成' ? '本轮已完成' : '未开始' }}</small></article>
    </section>

    <section class="grid main-grid">
      <article class="panel p-4">
        <div class="panel-head">
          <div><h2>逐项对账进度</h2><p class="muted">以旧修订为基准三方合并，历史数据缺字段时按旧修订回填索引</p></div>
          <UBadge v-if="session" color="blue" variant="subtle">{{ session.id }}</UBadge>
        </div>
        <UProgress v-if="session" :value="progress" class="mb-4" />
        <div class="table-scroll"><table class="data-table"><thead><tr><th>许可</th><th>状态</th><th>待补传</th><th>对账结果</th></tr></thead><tbody>
          <tr v-for="permit in store.permits" :key="permit.id">
            <td><b>{{ permit.id }}</b><small class="block muted">{{ permit.title }}</small></td>
            <td><UBadge color="amber" variant="subtle">{{ permit.status }}</UBadge></td>
            <td>{{ pendingOpsByPermit[permit.id] ?? 0 }} 项</td>
            <td>
              <UBadge :color="rowColor[rowStatus(permit.id)]" variant="subtle">{{ rowStatus(permit.id) }}</UBadge>
              <UBadge v-if="permit.acceptanceInvalid" color="red" variant="subtle" class="ml-1">验收失效</UBadge>
              <UBadge v-if="permit.conflicts?.length" color="red" variant="subtle" class="ml-1">冲突 {{ permit.conflicts.length }}</UBadge>
            </td>
          </tr>
        </tbody></table></div>

        <h3 class="section-title">待补传操作（断网本地记账）</h3>
        <div v-if="!store.pendingOps.length" class="empty">无待补传操作</div>
        <div v-for="op in store.pendingOps" :key="op.opId" class="op-row">
          <UBadge color="gray" variant="subtle">{{ opTypeLabel[op.type] }}</UBadge>
          <span class="op-id">{{ op.opId }}</span>
          <span class="muted">{{ op.permitId }} · {{ op.createdAt }}</span>
        </div>
      </article>

      <aside class="grid side-grid">
        <article class="panel p-4">
          <h2>冲突字段复核</h2>
          <p class="muted">两边都碰过的字段不整份替换；裁决前许可保持待复核，操作日志不重复生成。</p>
          <div v-if="!conflictRows.length" class="empty">无待复核冲突</div>
          <div v-for="({ permit, conflict }) in conflictRows" :key="conflict.id" class="conflict-card">
            <div class="conflict-head"><b>{{ permit.id }}</b><span>{{ conflict.label }}</span></div>
            <div class="conflict-grid">
              <div><small>旧修订</small><span>{{ valueText(conflict.base) }}</span></div>
              <div><small>端侧记录</small><span class="local">{{ valueText(conflict.local) }}</span></div>
              <div><small>调度端记录</small><span class="remote">{{ valueText(conflict.remote) }}</span></div>
            </div>
            <div class="inline mt-2">
              <UButton size="xs" color="blue" variant="soft" @click="store.resolveConflict(permit.id, conflict.field, 'local')">保留端侧</UButton>
              <UButton size="xs" color="violet" variant="soft" @click="store.resolveConflict(permit.id, conflict.field, 'remote')">采纳调度端</UButton>
            </div>
          </div>
        </article>

        <article class="panel p-4">
          <h2>验收结论重新确认</h2>
          <p class="muted">调度端已审批、签署或解除隔离后，受影响的现场验收结论先失效；重新确认后才允许继续推进。</p>
          <div v-if="!invalidatedRows.length" class="empty">无失效验收结论</div>
          <div v-for="permit in invalidatedRows" :key="permit.id" class="invalid-card">
            <b>{{ permit.id }}</b>
            <p>{{ permit.acceptanceInvalidReason }}</p>
            <UButton size="xs" color="red" variant="soft" icon="i-heroicons-check-badge" @click="store.reconfirmAcceptance(permit.id)">逐项重新确认</UButton>
          </div>
        </article>
      </aside>
    </section>
  </div>
</template>

<style scoped>
.head{display:flex;justify-content:space-between;align-items:flex-start;gap:18px;margin-bottom:18px}.head h1{margin:3px 0 7px}.head p{margin:0;max-width:760px}.eyebrow{font-size:12px;color:#2563eb;font-weight:700}.metrics{grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:16px}.metric{padding:17px}.main-grid{grid-template-columns:minmax(0,1.65fr) minmax(320px,.7fr);gap:16px}.panel-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}.panel-head h2{margin:0;font-size:17px}.panel-head p{margin:3px 0 0;font-size:12px}.section-title{font-size:15px;margin:22px 0 10px}.side-grid{gap:14px;align-content:start}.side-grid h2{font-size:17px;margin:0 0 8px}.empty{padding:14px;border:1px dashed #d5dbe5;border-radius:8px;color:#94a3b8;font-size:13px;text-align:center}.op-row{display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid #edf0f5;font-size:13px}.op-id{font-family:monospace;color:#475569;font-size:12px}.conflict-card{border:1px solid #edf0f5;border-radius:8px;padding:12px;margin-bottom:10px}.conflict-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}.conflict-head span{font-size:12px;color:#667085}.conflict-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}.conflict-grid>div{background:#f8fafc;border-radius:6px;padding:8px}.conflict-grid small{display:block;color:#94a3b8;font-size:11px;margin-bottom:3px}.conflict-grid span{font-size:13px}.conflict-grid .local{color:#2563eb}.conflict-grid .remote{color:#7c3aed}.invalid-card{border:1px solid #fecaca;background:#fef2f2;border-radius:8px;padding:12px;margin-bottom:10px}.invalid-card p{margin:6px 0 10px;font-size:13px;color:#7f1d1d}.block{display:block}.ml-1{margin-left:4px}.mt-2{margin-top:8px}
@media(max-width:1100px){.metrics{grid-template-columns:1fr 1fr}.main-grid{grid-template-columns:1fr}}@media(max-width:620px){.head{flex-direction:column}.metrics{grid-template-columns:1fr}.conflict-grid{grid-template-columns:1fr}}
</style>
