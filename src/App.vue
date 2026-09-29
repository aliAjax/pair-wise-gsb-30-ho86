<script setup lang="ts">
import { computed, ref } from "vue";
import { useDispatchStore } from "./dispatch/store";
import { TERMINAL_STATUSES, type OrderStatus } from "./dispatch/engine";

const store = useDispatchStore();

const stations = ["城东站", "机场站", "新区站"] as const;
const stationFilter = ref("全部油站");
const statusFilter = ref<"全部状态" | OrderStatus>("全部状态");
const message = ref<{ ok: boolean; text: string } | null>(null);
let messageTimer: ReturnType<typeof setTimeout> | undefined;

function flash(ok: boolean, text: string) {
  message.value = { ok, text };
  clearTimeout(messageTimer);
  messageTimer = setTimeout(() => (message.value = null), 6000);
}

const selectedFuel = computed(() => store.fuels.find((item) => item.fuel === store.draft.fuel) ?? null);
const draftHasContent = computed(
  () =>
    store.draft.station !== "" ||
    store.draft.fuel !== "" ||
    store.draft.tons !== "" ||
    store.draft.arriveAt !== ""
);
const draftStale = computed(
  () => draftHasContent.value && store.draft.baseVersion !== store.version && !store.busy
);

const filteredOrders = computed(() =>
  store.orders.filter((record) => {
    const stationOk = stationFilter.value.startsWith("全部") || record.station === stationFilter.value;
    const statusOk = statusFilter.value === "全部状态" || record.status === statusFilter.value;
    return stationOk && statusOk;
  })
);

const chartRows = computed(() =>
  store.statuses.map((status) => ({
    status,
    value: store.orders.filter((record) => record.status === status).length
  }))
);
const maxChart = computed(() => Math.max(1, ...chartRows.value.map((row) => row.value)));

const metrics = computed(() => [
  { label: "配送单", value: store.orders.length },
  { label: "进行中（预占+在途）", value: store.activeOrders.length },
  { label: "当前占用（吨）", value: store.occupiedTonsAll },
  { label: "台账版本凭据", value: `v${store.version}` }
]);

async function submit() {
  const result = await store.reserve();
  flash(result.ok, result.ok ? "已预占罐容，配送单进入待装车" : result.message);
}

async function advance(id: string, to: OrderStatus) {
  const result = await store.advance(id, to);
  flash(
    result.ok,
    result.ok
      ? to === "运输中"
        ? "装车核销完成，罐容占用转为在途"
        : to === "已到站"
          ? "已确认到站"
          : "已释放占用罐容"
      : result.message
  );
}

function rebase() {
  store.rebaseDraft();
  flash(true, "已按最新罐容刷新版本凭据，草稿内容保留，可再次提交");
}

async function resumeMigration() {
  const result = await store.migrateNow();
  flash(result.ok, result.message);
}

function summary(record: (typeof store.orders)[number]) {
  return `${record.station} / ${record.fuel} / ${record.tons}吨 / ${record.status}（台账v${record.version}）`;
}

function isTerminal(status: OrderStatus) {
  return TERMINAL_STATUSES.has(status);
}
</script>

<template>
  <main class="app">
    <div class="shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">石油行业 · 版本化调度台</p>
          <h1>油罐车配送调度台</h1>
          <p class="subtitle">
            派车前从油库可用吨数预占，装车核销，撤单或在途失败即释放；
            每次写入携带台账版本凭据，并发提交冲突时保留草稿、按最新占用重试。
          </p>
        </div>
        <div class="credential">
          <span class="credential-label">当前台账凭据</span>
          <strong>v{{ store.version }}</strong>
          <span class="credential-hint">并发写入以版本号校验</span>
        </div>
      </header>

      <!-- 一次性迁移条：中断重开只续未完成部分 -->
      <section v-if="store.migrationInfo.phase !== 'done'" class="migration-banner">
        <div class="migration-text">
          <strong>
            {{ store.migrationInfo.phase === "migrating" ? "正在迁移旧版配送单" : "准备迁移旧版配送单" }}
          </strong>
          <span>
            进度 {{ store.migrationInfo.done }} / {{ store.migrationInfo.total }}
            （每张单据与检查点同事务落账，关闭页面后重开只续未完成项，不会重复扣减）
          </span>
        </div>
        <div class="migration-track">
          <div
            class="migration-fill"
            :style="{
              width: `${store.migrationInfo.total ? (store.migrationInfo.done / store.migrationInfo.total) * 100 : 0}%`
            }"
          />
        </div>
        <button type="button" :disabled="store.busy" @click="resumeMigration">
          {{ store.busy ? "迁移进行中…" : "继续未完成迁移" }}
        </button>
      </section>
      <section v-else class="migration-banner done">
        <div class="migration-text">
          <strong>旧版本地留存已一次性迁入新台账</strong>
          <span>共 {{ store.migrationInfo.total }} 项，旧数据已改名归档，不会重复迁移或重复扣减。</span>
        </div>
        <button type="button" class="secondary" @click="resumeMigration">校验迁移状态</button>
      </section>

      <section class="metrics">
        <article v-for="metric in metrics" :key="metric.label" class="metric">
          <span>{{ metric.label }}</span>
          <strong>{{ metric.value }}</strong>
        </article>
      </section>

      <!-- 油库罐容：占用完全由单据状态投影，余量不可能被覆盖丢失 -->
      <section class="capacity-grid">
        <article v-for="fuel in store.fuels" :key="fuel.fuel" class="capacity-card">
          <header>
            <strong>{{ fuel.fuel }}</strong>
            <span class="available">可用 {{ fuel.available }} 吨</span>
          </header>
          <div class="capacity-track">
            <div
              class="capacity-fill"
              :class="{ tight: fuel.occupationRate >= 0.85 }"
              :style="{ width: `${Math.min(100, fuel.occupationRate * 100)}%` }"
            />
          </div>
          <div class="capacity-detail">
            <span>总罐容 {{ fuel.total }}</span>
            <span>待装预占 {{ fuel.reserved }}</span>
            <span>在途 {{ fuel.inTransit }}</span>
            <span>已送达 {{ fuel.delivered }}</span>
          </div>
        </article>
      </section>

      <section class="workspace">
        <form class="panel" @submit.prevent="submit">
          <h2>派车预占</h2>

          <div v-if="draftStale" class="conflict-box">
            <p>
              <strong>台账占用已变化</strong>（你基于 v{{ store.draft.baseVersion }}，当前为 v{{ store.version }}）。
              上一窗口的罐容占用已保留，下面是你的草稿，未被覆盖。
            </p>
            <button type="button" class="secondary" @click="rebase">按最新罐容继续（保留草稿）</button>
          </div>

          <div class="form-grid">
            <label>
              目标油站
              <select
                :value="store.draft.station"
                required
                @change="store.updateDraft({ station: ($event.target as HTMLSelectElement).value })"
              >
                <option value="">请选择</option>
                <option v-for="station in stations" :key="station">{{ station }}</option>
              </select>
            </label>
            <label>
              油品
              <select
                :value="store.draft.fuel"
                required
                @change="store.updateDraft({ fuel: ($event.target as HTMLSelectElement).value as never })"
              >
                <option value="">请选择</option>
                <option v-for="fuel in store.fuels" :key="fuel.fuel" :value="fuel.fuel">{{ fuel.fuel }}</option>
              </select>
            </label>
            <label>
              配送吨数
              <input
                :value="store.draft.tons"
                type="number"
                min="0.01"
                step="0.01"
                required
                @input="store.updateDraft({ tons: ($event.target as HTMLInputElement).valueAsNumber || '' })"
              />
              <small v-if="selectedFuel" class="hint">
                该油品当前可用 {{ selectedFuel.available }} 吨（已预占 {{ selectedFuel.reserved }}、
                在途 {{ selectedFuel.inTransit }}、已送达 {{ selectedFuel.delivered }}）
              </small>
            </label>
            <label>
              计划到达
              <input
                :value="store.draft.arriveAt"
                type="date"
                required
                @input="store.updateDraft({ arriveAt: ($event.target as HTMLInputElement).value })"
              />
            </label>
            <label>
              备注
              <textarea
                :value="store.draft.notes"
                placeholder="填写处理说明或现场备注（草稿自动留存）"
                @input="store.updateDraft({ notes: ($event.target as HTMLTextAreaElement).value })"
              />
            </label>
            <div class="draft-foot">
              <button type="submit">预占并生成配送单</button>
              <span class="credential-hint">提交凭据 v{{ store.draft.baseVersion || store.version }}</span>
            </div>
          </div>
        </form>

        <section class="list-panel">
          <div class="toolbar">
            <h2>配送单台账</h2>
            <div class="filters">
              <select v-model="stationFilter">
                <option>全部油站</option>
                <option v-for="station in stations" :key="station">{{ station }}</option>
              </select>
              <select v-model="statusFilter">
                <option>全部状态</option>
                <option v-for="status in store.statuses" :key="status">{{ status }}</option>
              </select>
            </div>
          </div>

          <transition name="toast">
            <div v-if="message" class="toast" :class="message.ok ? 'ok' : 'err'">{{ message.text }}</div>
          </transition>

          <div class="record-grid">
            <div v-if="filteredOrders.length === 0" class="empty">暂无匹配数据</div>
            <article
              v-for="record in filteredOrders"
              :key="record.id"
              class="record"
              :class="{ terminal: isTerminal(record.status) }"
            >
              <div class="record-head">
                <p class="record-title">
                  {{ record.station }} / {{ record.fuel }}
                  <span v-if="record.migrated" class="badge-migrated">旧版迁入</span>
                </p>
                <span class="status" :data-status="record.status">{{ record.status }}</span>
              </div>
              <div class="details">
                <span>配送吨数: {{ record.tons }} 吨</span>
                <span>计划到达: {{ record.arriveAt || "—" }}</span>
                <span>创建: {{ new Date(record.createdAt).toLocaleString() }}</span>
                <span>单据凭据: v{{ record.version }}</span>
              </div>
              <p class="note">{{ record.notes }}</p>
              <div class="actions">
                <template v-for="action in store.nextActions(record)" :key="action.to">
                  <button
                    type="button"
                    :class="action.tone === 'danger' ? 'danger' : ''"
                    @click="advance(record.id, action.to)"
                  >
                    {{ action.label }}
                  </button>
                </template>
                <button class="secondary" type="button" @click="navigator.clipboard?.writeText(summary(record))">
                  复制摘要
                </button>
              </div>
            </article>
          </div>

          <div class="mini-chart">
            <div v-for="row in chartRows" :key="row.status" class="bar">
              <span>{{ row.status }}</span>
              <div class="bar-track"><div class="bar-fill" :style="{ width: `${(row.value / maxChart) * 100}%` }" /></div>
              <strong>{{ row.value }}</strong>
            </div>
          </div>
        </section>
      </section>
    </div>
  </main>
</template>
