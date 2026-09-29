<script setup lang="ts">
import { computed, ref } from "vue";
import { useDispatchStore } from "./dispatch/store";
import { loadDraft, useDraftPersistence, clearDraft } from "./dispatch/draft";
import { availableTons, replay } from "./dispatch/reducer";
import type { Fuel, Order, OrderStatus } from "./dispatch/types";
import { FUELS, STATIONS, STATUS_LABEL } from "./dispatch/types";

const store = useDispatchStore();

const filterStation = ref("全部油站");
const filterStatus = ref<"all" | OrderStatus>("all");
const showAudit = ref(false);
const expanded = ref<Set<string>>(new Set());

const { draft, restored } = loadDraft(store.version);
useDraftPersistence(draft);

/** 实时可用吨数：随其它窗口的提交（storage 事件）即时变化 */
const selectedFuelCard = computed(() =>
  store.depotCards.find((card) => card.fuel === draft.fuel)
);

/** 后提交者视角：草稿依据版本落后于台账当前版本时给出占用变化提示 */
const versionStale = computed(
  () => draft.baseVersion > 0 && draft.baseVersion < store.version
);

/** 冲突后占用变化的油品（当前所选油品若被别人占用，会在此体现） */
function fuelDeltaSince(baseVersion: number, fuel: Fuel): number {
  const now = store.depotCards.find((card) => card.fuel === fuel);
  if (!now) return 0;
  return now.available - fuelAvailableAt(baseVersion, fuel);
}

// 通过对审计日志做轻量重放估算旧版本可用量，用于展示“占用已变化多少”
function fuelAvailableAt(version: number, fuel: Fuel): number {
  const commits = store.auditLog.slice().reverse();
  const past = replay(commits.slice(0, version));
  return availableTons(past, fuel);
}

const conflictMessage = ref("");

function submitReserve() {
  if (!draft.fuel || !draft.station || draft.tons <= 0 || !draft.arriveAt) {
    store.pushToast("error", "请完整填写油站、油品、吨数与计划到达日期");
    return;
  }
  const available = selectedFuelCard.value?.available ?? 0;
  if (draft.tons > available) {
    conflictMessage.value = `当前可用仅 ${available} 吨，无法预占 ${draft.tons} 吨，请调整吨数`;
    store.pushToast("error", conflictMessage.value);
    return;
  }
  const result = store.reserve(
    {
      station: draft.station,
      fuel: draft.fuel,
      tons: draft.tons,
      arriveAt: draft.arriveAt,
      notes: draft.notes
    },
    draft.baseVersion
  );
  if (result.ok) {
    conflictMessage.value = "";
    clearDraft();
    Object.assign(draft, {
      station: "",
      fuel: "",
      tons: 0,
      arriveAt: "",
      notes: "",
      baseVersion: store.version
    });
  } else if (result.reason === "conflict") {
    // 保留草稿，只刷新版本依据，让调度员看到最新占用后一键重试
    conflictMessage.value = result.message;
  } else {
    conflictMessage.value = result.message;
  }
}

/** 冲突解决：以最新版本为新的版本凭据，草稿内容原样保留 */
function rebaseDraft() {
  draft.baseVersion = store.version;
  conflictMessage.value = "";
  store.pushToast("ok", `已按最新台账 v${store.version} 刷新占用，草稿保留，可重新派车`);
}

const filteredOrders = computed(() =>
  store.orders.filter((order) => {
    const stationOk = filterStation.value === "全部油站" || order.station === filterStation.value;
    const statusOk = filterStatus.value === "all" || order.status === filterStatus.value;
    return stationOk && statusOk;
  })
);

const maxStatus = computed(() => Math.max(1, ...store.statusRows.map((row) => row.value)));

const statusClass: Record<OrderStatus, string> = {
  reserved: "st-reserved",
  loaded: "st-loaded",
  inTransit: "st-transit",
  arrived: "st-arrived",
  cancelled: "st-cancelled",
  failed: "st-failed"
};

function actionLabel(status: OrderStatus): string | null {
  switch (status) {
    case "reserved":
      return "装车核销";
    case "loaded":
      return "发车";
    case "inTransit":
      return "确认到站";
    default:
      return null;
  }
}

function primaryAction(order: Order) {
  if (order.status === "reserved") store.loadOrder(order.id);
  else if (order.status === "loaded") store.departOrder(order.id);
  else if (order.status === "inTransit") store.arriveOrder(order.id);
}

function toggleHistory(id: string) {
  const next = new Set(expanded.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expanded.value = next;
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString("zh-CN", { hour12: false });
  } catch {
    return iso;
  }
}

function eventSummary(commit: (typeof store.auditLog)[number]): string {
  return commit.events
    .map((event) => {
      switch (event.type) {
        case "depot:init":
          return event.reason === "migration" ? "初始化罐容(迁移)" : "初始化罐容";
        case "order:reserve":
          return `预占 ${event.order.tons}吨${event.order.fuel}→${event.order.station}`;
        case "order:loaded":
          return "装车核销";
        case "order:depart":
          return "发车在途";
        case "order:arrive":
          return "到站核销";
        case "order:release":
          return event.to === "cancelled" ? "撤单释放" : "在途失败释放";
        case "migration:item":
          return `迁移旧单 ${event.order.station}/${event.order.fuel}`;
        case "migration:complete":
          return `迁移完成(${event.total}条,跳过${event.skipped}条)`;
      }
    })
    .join("；");
}

const debugFuel = ref<Fuel>("95号汽油");
const debugTons = ref(10);
</script>

<template>
  <main class="app">
    <div class="shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">石油行业 · 版本化调度台</p>
          <h1>油品配送调度台</h1>
          <p class="subtitle">
            派车前预占油库可用吨数，装车核销、撤单或在途失败时释放；每次提交都带版本凭据，
            并发窗口后提交者会看到占用变化并保留草稿。
          </p>
        </div>
        <div class="version-badge">
          <span class="vb-label">台账版本</span>
          <strong>v{{ store.version }}</strong>
        </div>
      </header>

      <!-- 迁移进度条 -->
      <section v-if="store.state.migration.state !== 'idle'" class="migration">
        <template v-if="store.state.migration.state === 'running'">
          <strong>正在迁移旧版配送单…</strong>
          <span>已迁入 {{ store.state.migration.done }} / {{ store.state.migration.total }} 条</span>
          <span v-if="store.state.migration.skipped > 0" class="migration-skip">
            跳过 {{ store.state.migration.skipped }} 条无效旧单
          </span>
          <p class="migration-hint">迁移按条原子落账，中途关闭页面后重开只会继续未完成条目，不会重复扣减。</p>
        </template>
        <template v-else>
          <strong>旧版配送单迁移完成</strong>
          <span>共迁入 {{ store.state.migration.done }} 条，跳过 {{ store.state.migration.skipped }} 条</span>
          <span v-if="store.state.migration.finishedAt" class="migration-hint">
            完成于 {{ formatTime(store.state.migration.finishedAt) }}，旧留存已归档
          </span>
        </template>
      </section>

      <!-- 全局提示 -->
      <div class="toasts">
        <transition-group name="toast">
          <div v-for="toast in store.toasts" :key="toast.id" class="toast" :class="`toast-${toast.kind}`">
            {{ toast.message }}
          </div>
        </transition-group>
      </div>

      <section class="metrics">
        <article v-for="metric in store.metrics" :key="metric.label" class="metric">
          <span>{{ metric.label }}</span>
          <strong>{{ metric.value }}</strong>
        </article>
      </section>

      <!-- 油库罐容 -->
      <section class="depot">
        <article v-for="card in store.depotCards" :key="card.fuel" class="depot-card">
          <header>
            <h3>{{ card.fuel }}</h3>
            <span class="depot-total">总罐容 {{ card.total }} 吨</span>
          </header>
          <div class="depot-num">
            <strong>{{ card.available }}</strong>
            <span>可用（吨）</span>
          </div>
          <div class="depot-bar">
            <div class="seg seg-hold" :style="{ width: `${(card.hold / card.total) * 100}%` }" title="占用中" />
            <div class="seg seg-used" :style="{ width: `${(card.consumed / card.total) * 100}%` }" title="已到站核销" />
          </div>
          <footer>
            <span class="legend"><i class="dot dot-hold" />占用 {{ card.hold }} 吨</span>
            <span class="legend"><i class="dot dot-used" />已核销 {{ card.consumed }} 吨</span>
          </footer>
        </article>
      </section>

      <section class="workspace">
        <!-- 派车计划 -->
        <form class="panel plan-panel" @submit.prevent="submitReserve">
          <h2>派车计划</h2>

          <div v-if="restored" class="draft-restored">
            已恢复上次未完成的草稿（依据版本 v{{ draft.baseVersion }}）
          </div>

          <div class="form-grid">
            <label>
              目标油站
              <select v-model="draft.station" required>
                <option value="">请选择</option>
                <option v-for="station in STATIONS" :key="station" :value="station">{{ station }}</option>
              </select>
            </label>
            <label>
              油品
              <select v-model="draft.fuel" required>
                <option value="">请选择</option>
                <option v-for="fuel in FUELS" :key="fuel" :value="fuel">{{ fuel }}</option>
              </select>
            </label>
            <label>
              配送吨数
              <input v-model.number="draft.tons" type="number" min="0.1" step="0.1" required />
            </label>
            <label>
              计划到达
              <input v-model="draft.arriveAt" type="date" required />
            </label>
            <label class="full">
              备注
              <textarea v-model="draft.notes" placeholder="填写处理说明或现场备注" />
            </label>
          </div>

          <div v-if="draft.fuel" class="availability" :class="{ low: selectedFuelCard && draft.tons > selectedFuelCard.available }">
            <span>{{ draft.fuel }} 当前可用：<strong>{{ selectedFuelCard?.available ?? "-" }}</strong> 吨</span>
            <span v-if="selectedFuelCard && draft.tons > selectedFuelCard.available" class="over">
              超出 {{ draft.tons - selectedFuelCard.available }} 吨，无法预占
            </span>
          </div>

          <!-- 后提交者冲突提示：占用已变化，草稿保留 -->
          <div v-if="versionStale" class="conflict-banner">
            <p>
              其它窗口已提交新调度，台账从你打开草稿时的
              <strong>v{{ draft.baseVersion }}</strong> 推进到 <strong>v{{ store.version }}</strong>。
            </p>
            <p v-if="draft.fuel">
              {{ draft.fuel }}可用量变化：
              <strong :class="fuelDeltaSince(draft.baseVersion, draft.fuel as Fuel) < 0 ? 'neg' : 'pos'">
                {{ fuelDeltaSince(draft.baseVersion, draft.fuel as Fuel) > 0 ? "+" : ""
                }}{{ fuelDeltaSince(draft.baseVersion, draft.fuel as Fuel) }} 吨
              </strong>
            </p>
            <p v-if="conflictMessage" class="conflict-detail">{{ conflictMessage }}</p>
            <button type="button" class="secondary" @click="rebaseDraft">以最新占用刷新版本，保留草稿</button>
          </div>

          <div class="version-line">
            提交版本凭据：v{{ draft.baseVersion }} → v{{ store.version }}
          </div>
          <button type="submit" class="primary-btn">预占派车</button>
        </form>

        <!-- 配送单列表 -->
        <section class="list-panel">
          <div class="toolbar">
            <h2>配送单台账</h2>
            <div class="filters">
              <select v-model="filterStation">
                <option>全部油站</option>
                <option v-for="station in STATIONS" :key="station">{{ station }}</option>
              </select>
              <select v-model="filterStatus">
                <option value="all">全部状态</option>
                <option v-for="(label, key) in STATUS_LABEL" :key="key" :value="key">{{ label }}</option>
              </select>
              <button type="button" class="secondary small" @click="showAudit = !showAudit">
                {{ showAudit ? "收起版本日志" : "查看版本日志" }}
              </button>
            </div>
          </div>

          <!-- 版本凭据审计日志 -->
          <div v-if="showAudit" class="audit">
            <table>
              <thead>
                <tr>
                  <th>版本</th>
                  <th>时间</th>
                  <th>动作</th>
                  <th>明细</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(commit, index) in store.auditLog" :key="commit.id">
                  <td class="audit-ver">v{{ store.auditLog.length - index }}</td>
                  <td>{{ formatTime(commit.at) }}</td>
                  <td>{{ commit.label }}</td>
                  <td class="audit-detail">{{ eventSummary(commit) }}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div class="record-grid">
            <div v-if="filteredOrders.length === 0" class="empty">暂无匹配配送单</div>
            <article v-for="order in filteredOrders" :key="order.id" class="record">
              <div class="record-head">
                <div>
                  <p class="record-title">{{ order.station }} / {{ order.fuel }}</p>
                  <p class="record-meta">
                    {{ order.tons }} 吨 · 计划到达 {{ order.arriveAt }}
                    <span v-if="order.migrated" class="migrated-tag">旧版迁入</span>
                  </p>
                </div>
                <span class="status" :class="statusClass[order.status]">{{ STATUS_LABEL[order.status] }}</span>
              </div>

              <div class="version-tags">
                <span>预占凭据 v{{ order.reservedVersion }}</span>
                <span v-if="order.loadedVersion">装车凭据 v{{ order.loadedVersion }}</span>
              </div>

              <p class="note">{{ order.notes }}</p>

              <div v-if="expanded.has(order.id)" class="history">
                <p v-for="(entry, i) in order.history" :key="i" class="history-row">
                  <span class="history-time">{{ formatTime(entry.at) }}</span>
                  <span>{{ entry.from ? STATUS_LABEL[entry.from] : "建单" }} → {{ STATUS_LABEL[entry.to] }}</span>
                  <span class="history-ver">v{{ entry.version }}</span>
                  <em v-if="entry.note">{{ entry.note }}</em>
                </p>
              </div>

              <div class="actions">
                <button v-if="actionLabel(order.status)" type="button" @click="primaryAction(order)">
                  {{ actionLabel(order.status) }}
                </button>
                <button v-if="order.status === 'reserved'" type="button" class="secondary" @click="store.cancelOrder(order.id)">
                  撤单释放
                </button>
                <button
                  v-if="order.status === 'loaded' || order.status === 'inTransit'"
                  type="button"
                  class="danger"
                  @click="store.failOrder(order.id)"
                >
                  在途失败释放
                </button>
                <button type="button" class="secondary" @click="toggleHistory(order.id)">
                  {{ expanded.has(order.id) ? "收起凭据链" : "查看凭据链" }}
                </button>
              </div>
            </article>
          </div>

          <div class="mini-chart">
            <div v-for="row in store.statusRows" :key="row.status" class="bar">
              <span>{{ row.label }}</span>
              <div class="bar-track">
                <div class="bar-fill" :style="{ width: `${(row.value / maxStatus) * 100}%` }" />
              </div>
              <strong>{{ row.value }}</strong>
            </div>
          </div>
        </section>
      </section>

      <!-- 调试区：演示并发与迁移 -->
      <section class="debug">
        <h4>场景演示</h4>
        <div class="debug-row">
          <span>模拟另一调度窗口抢先预占</span>
          <select v-model="debugFuel">
            <option v-for="fuel in FUELS" :key="fuel" :value="fuel">{{ fuel }}</option>
          </select>
          <input v-model.number="debugTons" type="number" min="1" />
          <button type="button" class="secondary small" @click="store.simulateConcurrent(debugFuel, debugTons)">
            并发窗口提交
          </button>
          <span class="debug-hint">先在左侧填好派车计划，再点这里，提交时即会看到版本冲突提示。</span>
        </div>
        <div class="debug-row">
          <span>模拟旧版本地留存</span>
          <button type="button" class="secondary small" @click="store.injectLegacyDemo()">
            放入 3 条旧配送单并迁移
          </button>
          <span class="debug-hint">也可立即关闭页面再重开，验证迁移只能续跑、不会重复扣减。</span>
        </div>
      </section>
    </div>
  </main>
</template>
