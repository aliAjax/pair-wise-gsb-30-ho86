/**
 * 调度台 Pinia store：
 * - 所有台账写入经单队列串行化，同窗口不会交叉提交；
 * - 每次提交携带读入时的 version 凭据，冲突时抛 VersionConflictError，
 *   调用方保留草稿并基于刷新后的占用重试；
 * - 监听 storage 事件，别的窗口提交后本窗口台账即时刷新；
 * - 启动先做 WAL 崩溃恢复，再自动执行/续传一次性迁移。
 */
import { computed, reactive, ref } from "vue";
import { defineStore } from "pinia";
import {
  canAdvance,
  findOrder,
  fuelView,
  FUELS,
  isFuel,
  ORDER_STATUSES,
  occupiedTons,
  RuleError,
  TERMINAL_STATUSES,
  type DispatchOrder,
  type Fuel,
  type LedgerState,
  type NewOrder,
  type OrderStatus,
  type Txn
} from "./engine";
import {
  bootstrap,
  LedgerStorage,
  STATE_KEY,
  VersionConflictError,
  WAL_KEY,
  type KV
} from "./storage";
import {
  runMigration,
  type MigrationProgress
} from "./migration";

const DRAFT_KEY = "hxwlfront-19-dispatch-draft-v2";

export interface Draft {
  station: string;
  fuel: Fuel | "";
  tons: number | "";
  arriveAt: string;
  notes: string;
  /** 草稿所基于的台账版本；提交凭据落后时保留草稿并提示。 */
  baseVersion: number;
}

export interface ActionResult {
  ok: boolean;
  message: string;
  /** 冲突时返回最新版本，供界面决定是否保留草稿重试。 */
  currentVersion?: number;
}

function emptyDraft(version: number): Draft {
  return { station: "", fuel: "", tons: "", arriveAt: "", notes: "", baseVersion: version };
}

function loadDraft(version: number): Draft {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (raw) return { ...emptyDraft(version), ...(JSON.parse(raw) as Partial<Draft>) };
  } catch {
    /* 草稿损坏则重新开始，不影响台账 */
  }
  return emptyDraft(version);
}

export const useDispatchStore = defineStore("dispatch", () => {
  const kv: KV = localStorage;
  const storage = new LedgerStorage(kv, bootstrap(kv));

  const state = ref<LedgerState>(storage.snapshot());
  const draft = reactive<Draft>(loadDraft(state.value.version));
  const migration = ref<MigrationProgress>({
    phase: state.value.migration.phase,
    total: state.value.migration.total,
    done: state.value.migration.migratedIds.length
  });
  const lastEvent = ref<string>("");
  const busy = ref(false);

  let queue: Promise<unknown> = Promise.resolve();
  /** 串行化提交：同一窗口内后一个写入必须基于前一个写入后的版本。 */
  function enqueue<T>(task: () => Promise<T> | T): Promise<T> {
    const run = queue.then(task, task);
    queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  function syncFromStorage() {
    const next = storage.refresh();
    state.value = next;
  }

  /** 跨窗口：另一个窗口落盘 state/wal 后，本窗口重读最新台账与罐容占用。 */
  function onStorage(event: StorageEvent) {
    if (event.key !== STATE_KEY && event.key !== WAL_KEY && event.key !== null) return;
    syncFromStorage();
    if (event.key === STATE_KEY) {
      pushMigrationProgress();
    }
  }
  window.addEventListener("storage", onStorage);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) syncFromStorage();
  });

  function pushMigrationProgress() {
    const m = state.value.migration;
    migration.value = {
      phase: m.phase,
      total: m.total,
      done: m.phase === "done" ? m.total : m.migratedIds.length
    };
  }

  function persistDraft() {
    // 注意：只保存表单内容，绝不在用户输入时偷偷推进版本凭据，
    // 否则并发冲突永远不会被暴露。凭据只在提交成功或显式 rebase 后前进。
    localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  }

  /** 带凭据提交；冲突 / 业务错误都转成界面可直接展示的结果，绝不静默覆盖。 */
  async function commit(txn: Txn, expectedVersion: number): Promise<ActionResult> {
    return enqueue(() => {
      try {
        const next = storage.commit(txn, expectedVersion);
        state.value = next;
        persistDraftVersion(next.version);
        return { ok: true, message: "已提交", currentVersion: next.version };
      } catch (error) {
        if (error instanceof VersionConflictError) {
          state.value = storage.snapshot();
          lastEvent.value = error.message;
          return { ok: false, message: error.message, currentVersion: error.actual };
        }
        if (error instanceof RuleError) {
          return { ok: false, message: error.message };
        }
        throw error;
      }
    });
  }

  function persistDraftVersion(version: number) {
    // 单据提交成功后，草稿基版本推进到最新，但表单内容由调用方决定是否清空。
    draft.baseVersion = version;
  }

  /** 派车前先预占罐容（待装车），不修改任何罐容余量字段。 */
  async function reserve(): Promise<ActionResult> {
    if (!isFuel(draft.fuel)) return { ok: false, message: "请选择油品" };
    const tons = Number(draft.tons);
    if (!(tons > 0)) return { ok: false, message: "配送吨数必须大于 0" };
    if (!draft.station.trim()) return { ok: false, message: "请选择目标油站" };

    const now = new Date().toISOString();
    const order: NewOrder = {
      id: crypto.randomUUID(),
      station: draft.station.trim(),
      fuel: draft.fuel,
      tons,
      arriveAt: draft.arriveAt,
      notes: draft.notes.trim() || "派车前预占罐容",
      status: "待装车",
      createdAt: now,
      updatedAt: now
    };
    const result = await commit({ type: "reserve", order }, draft.baseVersion);
    if (result.ok) {
      Object.assign(draft, emptyDraft(result.currentVersion ?? state.value.version));
      localStorage.removeItem(DRAFT_KEY);
    }
    return result;
  }

  /** 装车核销 / 到站确认；撤单、在途失败则释放预占或在途占用。 */
  async function advance(id: string, to: OrderStatus): Promise<ActionResult> {
    const order = findOrder(state.value, id);
    if (!order) return { ok: false, message: "配送单不存在或已被其他窗口处理" };
    if (!canAdvance(order.status, to)) {
      return { ok: false, message: `不允许从「${order.status}」流转到「${to}」` };
    }
    // 凭据是“整份台账的版本”，不是单据自身版本；期间别的单据提交过也要先看见。
    return commit(
      { type: "advance", id, to, at: new Date().toISOString() },
      state.value.version
    );
  }

  /** 冲突提示后，用户保留原草稿并“按最新罐容继续”：只更新凭据，不动表单内容。 */
  function rebaseDraft() {
    draft.baseVersion = state.value.version;
    persistDraft();
  }

  function updateDraft(patch: Partial<Draft>) {
    Object.assign(draft, patch);
    persistDraft();
  }

  async function migrateNow(): Promise<ActionResult> {
    if (busy.value) return { ok: false, message: "迁移正在进行" };
    busy.value = true;
    try {
      const result = await enqueue(() =>
        runMigration(
          storage,
          kv,
          (progress) => {
            migration.value = progress;
            syncFromStorage();
          },
          140
        )
      );
      syncFromStorage();
      pushMigrationProgress();
      const parts: string[] = [];
      if (result.resumed) parts.push("已从中断点继续未完成迁移");
      parts.push(`迁入 ${result.migrated} 张配送单`);
      if (result.skipped.length > 0) parts.push(`跳过 ${result.skipped.length} 条无效旧数据（未扣减罐容）`);
      return { ok: true, message: parts.join("，") };
    } finally {
      busy.value = false;
    }
  }

  // 启动恢复后自动执行一次性迁移；若上次中途关闭，则只继续未完成部分。
  void migrateNow().catch((error) => {
    // 迁移器本身对冲突/中断幂等可续；此处仅兜底，避免未处理拒绝，用户仍可手动续迁。
    console.error("[dispatch] 启动迁移未完成，可点击“继续未完成迁移”：", error);
  });

  const fuels = computed(() => FUELS.map((fuel) => fuelView(state.value, fuel)));
  const orders = computed(() => state.value.orders);
  const version = computed(() => state.value.version);
  const migrationInfo = computed(() => migration.value);

  const activeOrders = computed(() =>
    state.value.orders.filter((order) => !TERMINAL_STATUSES.has(order.status))
  );
  const totalTons = computed(() =>
    state.value.orders.reduce((sum, order) => sum + order.tons, 0)
  );
  const occupiedTonsAll = computed(() =>
    state.value.orders.reduce((sum, order) => sum + occupiedTons(order), 0)
  );

  function nextActions(order: DispatchOrder): { to: OrderStatus; label: string; tone: "primary" | "danger" }[] {
    if (order.status === "待装车") {
      return [
        { to: "运输中", label: "装车核销，发运", tone: "primary" },
        { to: "已撤单", label: "撤单并释放", tone: "danger" }
      ];
    }
    if (order.status === "运输中") {
      return [
        { to: "已到站", label: "确认到站", tone: "primary" },
        { to: "在途失败", label: "在途失败，释放", tone: "danger" }
      ];
    }
    return [];
  }

  return {
    // 状态
    state,
    draft,
    version,
    orders,
    activeOrders,
    totalTons,
    occupiedTonsAll,
    fuels,
    migrationInfo,
    lastEvent,
    busy,
    statuses: ORDER_STATUSES,
    // 动作
    reserve,
    advance,
    rebaseDraft,
    updateDraft,
    migrateNow,
    refresh: () => enqueue(() => syncFromStorage()),
    nextActions
  };
});
