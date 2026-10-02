<script setup lang="ts">
import { useOperationsStore } from '~/stores/operations'
import type { OutboxSyncState } from '~/types'

const store = useOperationsStore()

const syncColor: Record<OutboxSyncState, string> = {
  待提交: 'amber',
  已接收: 'green',
  双方一致: 'green',
  冲突待复核: 'red',
  复核按现场: 'blue',
  复核按调度: 'blue',
}

const phases = computed(() => [
  { label: '端侧断网本地记录', done: store.restoredOutage, active: store.connection === '离线' },
  { label: '线路恢复装载快照', done: store.snapshotLoaded, active: store.connection === '在线' && !store.snapshotLoaded },
  { label: '逐项字段对账', done: store.reconcileDone, active: store.snapshotLoaded && !store.reconcileDone },
  { label: '冲突复核 / 验收重认', done: store.reconcileDone && store.conflicts.every((item) => item.state === '已解决') && !store.permits.some((p) => p.acceptance && !p.acceptance.valid), active: store.reconcileDone },
])

const pending = computed(() => store.pendingPermitIds)
const openConflicts = computed(() => store.conflicts.filter((item) => item.state === '待复核'))
const invalidPermits = computed(() => store.permits.filter((permit) => permit.acceptance && !permit.acceptance.valid))
const legacy = computed(() => store.permits.filter((permit) => permit.legacy))
const legacyLogs = computed(() => store.audit.filter((event) => legacy.value.some((permit) => event.target.includes(permit.id))))

const reconfirmText = reactive<Record<string, string>>({})
function reconfirm(permitId: string) {
  const text = reconfirmText[permitId]?.trim()
  if (!text) return
  store.reconfirmAcceptance(permitId, text)
  reconfirmText[permitId] = ''
}

const permitTitle = (id: string) => store.permits.find((item) => item.id === id)?.title ?? id
</script>

<template>
  <div class="page">
    <div class="head">
      <div>
        <p class="eyebrow">断线重连 · 字段级对账</p>
        <h1 class="page-title">端侧 — 调度端对账中心</h1>
        <p class="muted">断网时许可步骤与隔离措施记在端侧；线路恢复后与调度端逐项对账，只接收无争议字段，冲突字段与失效验收留待复核。</p>
      </div>
      <div class="inline wrap">
        <UBadge size="lg" :color="store.connection === '在线' ? 'green' : 'red'" variant="subtle">{{ store.connection === '在线' ? '线路已恢复' : '端侧断网中' }}</UBadge>
        <UButton color="gray" variant="outline" icon="i-heroicons-arrow-path" @click="store.resetDemo()">重置演示</UButton>
      </div>
    </div>

    <section class="panel p-4 mb-4">
      <div class="phase-row">
        <div v-for="(phase, index) in phases" :key="phase.label" class="phase" :class="{ done: phase.done, active: phase.active }">
          <i>{{ phase.done ? '✓' : index + 1 }}</i><span>{{ phase.label }}</span>
        </div>
      </div>
      <div class="inline wrap mt-4">
        <UButton color="red" variant="soft" icon="i-heroicons-signal-slash" :disabled="store.connection === '离线'" @click="store.markOffline()">模拟端侧断网</UButton>
        <UButton color="primary" icon="i-heroicons-signal" :disabled="store.connection === '在线'" @click="store.markOnline()">线路恢复 / 连接调度端</UButton>
        <UButton color="gray" variant="outline" icon="i-heroicons-pause-circle" :disabled="!store.snapshotLoaded || store.reconcileDone" @click="store.interruptReconcile()">模拟对账中断</UButton>
        <UButton color="green" variant="soft" icon="i-heroicons-arrow-right-circle" :disabled="!store.snapshotLoaded || store.reconcileDone" @click="store.reconcileNext()">逐项对账（下一张许可）</UButton>
        <UButton color="primary" icon="i-heroicons-arrow-up-on-square-stack" :disabled="!store.snapshotLoaded || store.reconcileDone" @click="store.resumeReconcile()">中断后续传：只补未完成许可</UButton>
      </div>
      <UAlert
        v-if="store.connection === '离线'" class="mt-4" color="red" variant="soft"
        title="端侧断网：本地记录模式"
        description="现场执行的许可步骤与隔离措施写入端侧待提交队列，不等待调度端确认；线路恢复后再按许可逐项对账。"
      />
      <UAlert
        v-else-if="!store.snapshotLoaded" class="mt-4" color="amber" variant="soft"
        title="等待装载调度端快照"
        description="点击「线路恢复 / 连接调度端」获取断网期间调度端的审批、签署与隔离解除记录。"
      />
      <UAlert
        v-else-if="store.report" class="mt-4" color="green" variant="soft"
        :title="`已对账 ${store.report.items.length} 张许可${store.reconcileDone ? '（全部完成）' : '，可继续逐项对账或模拟中断后续传'}`"
        description="双方都碰过的许可不整份替换：无争议字段已接收，冲突字段保留现场值并挂起待复核；重复提交不会再次生成操作日志。"
      />
    </section>

    <div class="grid sync-grid">
      <section class="panel p-4">
        <div class="panel-head">
          <div><h2>端侧待提交记录</h2><p class="muted">断网期间本地记录的许可步骤与隔离措施，按许可逐项对账</p></div>
          <UBadge color="amber" variant="subtle">待提交 {{ store.pendingRetry }} 项</UBadge>
        </div>
        <div class="table-scroll">
          <table class="data-table">
            <thead><tr><th>许可</th><th>本地记录字段</th><th>现场值</th><th>记录人 / 时间</th><th>提交状态</th></tr></thead>
            <tbody>
              <tr v-for="entry in store.outbox" :key="entry.id">
                <td><b>{{ entry.permitId }}</b></td>
                <td>{{ entry.fieldLabel }}</td>
                <td>{{ entry.localValue === true ? '是' : entry.localValue === false ? '否' : entry.localValue }}</td>
                <td>{{ entry.recordedBy }}<small class="block muted">{{ entry.recordedAt }}</small></td>
                <td><UBadge size="xs" :color="syncColor[entry.sync]" variant="subtle">{{ entry.sync }}</UBadge></td>
              </tr>
            </tbody>
          </table>
        </div>

        <h3 class="mt-4">待对账队列</h3>
        <div v-if="pending.length" class="queue">
          <span v-for="id in pending" :key="id" class="chip"><b>{{ id }}</b><small>{{ permitTitle(id) }}</small></span>
        </div>
        <p v-else class="muted small">队列为空：所有本地记录均已对账。此时再次点击「续传」不会补任何许可，也不会重复生成日志。</p>
      </section>

      <aside class="grid side-col">
        <article class="panel p-4">
          <h2>冲突字段复核</h2>
          <UAlert v-if="!openConflicts.length" color="green" variant="soft" title="无待复核冲突" description="双方都碰过的字段取值一致，或已由值班负责人裁决。" />
          <div v-for="conflict in openConflicts" :key="`${conflict.permitId}-${conflict.path}`" class="conflict">
            <div class="inline justify-between wrap"><b>{{ conflict.permitId }}</b><UBadge color="red" size="xs" variant="subtle">双方取值不一致</UBadge></div>
            <p>{{ conflict.fieldLabel }}</p>
            <div class="grid values"><div><small>端侧现场值</small><b>{{ conflict.localValue }}</b></div><div><small>调度端值 · {{ conflict.dispatchBy }} · {{ conflict.dispatchAt }}</small><b>{{ conflict.dispatchValue }}</b></div></div>
            <div class="inline">
              <UButton size="xs" color="red" variant="soft" icon="i-heroicons-building-office-2" @click="store.resolveConflict(conflict.permitId, conflict.path, 'dispatch')">采用调度端</UButton>
              <UButton size="xs" color="blue" variant="soft" icon="i-heroicons-user-group" @click="store.resolveConflict(conflict.permitId, conflict.path, 'local')">维持现场值</UButton>
            </div>
          </div>
        </article>

        <article class="panel p-4">
          <h2>验收结论重新确认</h2>
          <UAlert v-if="!invalidPermits.length" color="gray" variant="soft" title="无需重新确认" description="调度端未在断网期间审批、签署或解除隔离。" />
          <div v-for="permit in invalidPermits" :key="permit.id" class="invalid">
            <div class="inline justify-between wrap"><b>{{ permit.id }}</b><UBadge color="red" size="xs" variant="subtle">验收已失效</UBadge></div>
            <p class="muted">原结论：{{ permit.acceptance?.conclusion }}（{{ permit.acceptance?.confirmedBy }} · {{ permit.acceptance?.confirmedAt }}）</p>
            <p class="danger">失效原因：{{ permit.acceptance?.invalidReason }}。须重新核对隔离边界后再确认。</p>
            <div class="inline">
              <UInput v-model="reconfirmText[permit.id]" size="sm" placeholder="输入重新确认的验收结论" class="reconfirm-input" />
              <UButton size="sm" color="primary" icon="i-heroicons-check-badge" :disabled="!reconfirmText[permit.id]?.trim()" @click="reconfirm(permit.id)">重新确认</UButton>
            </div>
          </div>
        </article>
      </aside>
    </div>

    <section v-if="store.report" class="panel p-4 mt-4">
      <h2>对账结果（按许可逐项）</h2>
      <p class="muted">双方都碰过的许可未整份替换；仅接收没有争议的内容。</p>
      <div v-for="item in store.report.items" :key="item.permitId" class="rc-item">
        <div class="inline justify-between wrap">
          <div class="inline"><b>{{ item.permitId }}</b><small class="muted">{{ permitTitle(item.permitId) }}</small></div>
          <UBadge :color="item.conflicts.length ? 'red' : item.invalidReason ? 'amber' : 'green'" variant="subtle">
            {{ item.invalidReason ? '验收失效待重新确认' : item.conflicts.length ? '部分字段待复核' : '已对账无争议' }}
          </UBadge>
        </div>
        <ul v-if="item.lifecycle.length" class="lifecycle">
          <li v-for="(line, index) in item.lifecycle" :key="index"><UIcon name="i-heroicons-building-office-2" />{{ line }}</li>
        </ul>
        <ul class="accepted">
          <li v-for="field in item.accepted" :key="field.entryId"><UIcon name="i-heroicons-check-circle" class="ok" />{{ field.label }} — {{ field.note }}</li>
          <li v-for="field in item.dispatchOnly" :key="field.path"><UIcon name="i-heroicons-arrow-down-tray" class="dispatch" />{{ field.label }} — 仅调度端补录，直接接收「{{ field.value }}」（{{ field.by }} · {{ field.at }}）</li>
          <li v-for="field in item.conflicts" :key="field.path"><UIcon name="i-heroicons-exclamation-triangle" class="warn" />{{ field.fieldLabel }} — 现场「{{ field.localValue }}」≠ 调度「{{ field.dispatchValue }}」，冲突字段留待复核</li>
        </ul>
      </div>
    </section>

    <section class="panel p-4 mt-4">
      <h2>旧修订历史数据回填</h2>
      <p class="muted">历史许可缺少 revision、设备归属、步骤责任人等原始字段时，按旧修订回填索引；隔离措施与操作日志仍可查询。</p>
      <div v-for="permit in legacy" :key="permit.id" class="legacy">
        <div class="inline justify-between wrap">
          <div class="inline"><b>{{ permit.id }}</b><UBadge color="gray" size="xs" variant="subtle">旧修订回填</UBadge></div>
          <code class="idx">{{ permit.legacyIndex }}</code>
        </div>
        <div class="grid legacy-grid">
          <div>
            <small class="muted">隔离措施（设备缺失已回填归属）</small>
            <div v-for="point in permit.isolationPoints" :key="point.id" class="legacy-row"><UIcon name="i-heroicons-lock-closed" /><span>{{ point.label }}</span><small class="muted">{{ point.device }} · {{ point.type }} · {{ point.state }}</small></div>
          </div>
          <div>
            <small class="muted">操作日志（步骤责任人缺失已按负责人回填）</small>
            <div v-for="step in permit.steps" :key="step.id" class="legacy-row"><UIcon name="i-heroicons-clipboard-document-list" /><span>{{ step.text }}</span><small class="muted">{{ step.owner }} · {{ step.done ? '已完成' : '未完成' }}</small></div>
            <div v-for="log in legacyLogs.filter((event) => event.target.includes(permit.id))" :key="log.id" class="legacy-row"><UIcon name="i-heroicons-clock" /><span>{{ log.action }}</span><small class="muted">{{ log.actor }} · {{ log.time }}</small></div>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.head{display:flex;justify-content:space-between;gap:16px;margin-bottom:18px}.head h1{margin:3px 0 7px}.head p{margin:0}.eyebrow{font-size:12px;color:#2563eb;font-weight:700}.mb-4{margin-bottom:16px}.mt-4{margin-top:14px}
.phase-row{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}.phase{display:flex;align-items:center;gap:9px;padding:10px 12px;border:1px solid #e2e8f0;border-radius:8px;color:#94a3b8;font-size:13px}.phase i{display:grid;place-items:center;width:24px;height:24px;border-radius:50%;background:#e2e8f0;font-style:normal;font-size:12px;font-weight:700}.phase.active{border-color:#f59e0b;color:#92400e;background:#fffbeb}.phase.active i{background:#f59e0b;color:#fff}.phase.done{color:#166534}.phase.done i{background:#16a34a;color:#fff}
.sync-grid{grid-template-columns:minmax(0,1.6fr) minmax(320px,.8fr);gap:16px;align-items:start}.side-col{gap:14px}.panel-head{display:flex;justify-content:space-between;gap:10px;margin-bottom:10px}.panel-head h2{margin:0}.panel-head p{margin:3px 0 0;font-size:12px}.panel h2{font-size:17px;margin:0 0 10px}.panel h3{font-size:14px;margin:14px 0 8px}
.queue{display:flex;flex-wrap:wrap;gap:8px}.chip{display:inline-flex;flex-direction:column;border:1px dashed #f59e0b;background:#fffbeb;border-radius:7px;padding:7px 10px}.chip b{font-size:12px}.chip small{color:#92400e;font-size:11px}.small{font-size:12px}
.conflict,.invalid{border:1px solid #fecaca;background:#fef2f2;border-radius:8px;padding:12px;margin-bottom:10px}.conflict p{margin:8px 0;font-size:13px}.values{grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px}.values div{background:#fff;border:1px solid #e2e8f0;border-radius:7px;padding:8px}.values small{display:block;color:#667085;font-size:11px}.values b{display:block;margin-top:3px;font-size:14px}.invalid p{font-size:13px;margin:8px 0}.reconfirm-input{flex:1;min-width:180px}
.rc-item{border:1px solid #e2e8f0;border-radius:8px;padding:13px;margin-top:10px}.rc-item>ul{margin:8px 0 0;padding:0;list-style:none}.rc-item li{display:flex;gap:8px;align-items:flex-start;font-size:13px;padding:4px 0}.lifecycle li{color:#1e40af}.lifecycle svg{margin-top:2px;flex:none}.ok{color:#16a34a;margin-top:2px;flex:none}.dispatch{color:#2563eb;margin-top:2px;flex:none}.warn{color:#dc2626;margin-top:2px;flex:none}
.idx{font-size:11px;color:#475569;background:#f1f5f9;padding:3px 7px;border-radius:5px}.legacy{border-top:1px solid #edf0f5;padding:14px 0;margin-top:12px}.legacy-grid{grid-template-columns:1fr 1fr;gap:18px;margin-top:10px}.legacy-row{display:flex;align-items:center;gap:8px;padding:6px 0;font-size:13px;border-bottom:1px dashed #edf0f5}.legacy-row span{flex:1}.legacy-row svg{color:#2563eb;flex:none}
@media(max-width:1080px){.phase-row{grid-template-columns:1fr 1fr}.sync-grid,.legacy-grid{grid-template-columns:1fr}}@media(max-width:620px){.head{flex-direction:column}.phase-row{grid-template-columns:1fr}}
</style>
