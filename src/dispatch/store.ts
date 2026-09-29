import { computed, ref } from "vue";
import { defineStore } from "pinia";
import { activeHold, availableTons, consumedTons } from "./reducer";
import { engine, uid } from "./engine";
import type { CommitResult, Fuel, LedgerState, Order, ReserveInput } from "./types";
import { STATUS_LABEL } from "./types";

export interface Toast {
  id: string;
  kind: "ok" | "warn" | "error";
  message: string;
}

export const useDispatchStore = defineStore("dispatch", () => {
  const state = ref<LedgerState>(engine.state);
  const toasts = ref<Toast[]>([]);

  engine.subscribe((next) => {
    state.value = next;
  });

  function pushToast(kind: Toast["kind"], message: string) {
    const toast = { id: uid("toast"), kind, message };
    toasts.value = [...toasts.value, toast];
    window.setTimeout(() => {
      toasts.value = toasts.value.filter((item) => item.id !== toast.id);
    }, 4200);
  }

  function report(result: CommitResult, okMessage: string): boolean {
    if (result.ok) {
      pushToast("ok", `${okMessage}（版本凭据 v${result.version}）`);
      return true;
    }
    pushToast(result.reason === "conflict" ? "warn" : "error", result.message);
    return false;
  }

  const version = computed(() => state.value.version);
  const orders = computed<Order[]>(() =>
    Object.values(state.value.orders).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  );

  const depotCards = computed(() =>
    ["92号汽油", "95号汽油", "柴油"].map((fuel) => {
      const key = fuel as Fuel;
      const total = state.value.depot[key];
      const hold = activeHold(state.value, key);
      const consumed = consumedTons(state.value, key);
      return {
        fuel: key,
        total,
        hold,
        consumed,
        available: availableTons(state.value, key)
      };
    })
  );

  const metrics = computed(() => {
    const list = Object.values(state.value.orders);
    const active = list.filter((order) =>
      ["reserved", "loaded", "inTransit"].includes(order.status)
    );
    const inTransit = list.filter((order) => order.status === "inTransit").length;
    const arrivedTons = list
      .filter((order) => order.status === "arrived")
      .reduce((sum, order) => sum + order.tons, 0);
    return [
      { label: "在管配送单", value: list.length },
      { label: "占用中", value: active.length },
      { label: "在途", value: inTransit },
      { label: "已到站吨数", value: arrivedTons }
    ];
  });

  const statusRows = computed(() =>
    (Object.keys(STATUS_LABEL) as Array<keyof typeof STATUS_LABEL>).map((status) => ({
      status,
      label: STATUS_LABEL[status],
      value: Object.values(state.value.orders).filter((order) => order.status === status).length
    }))
  );

  /** 提交日志倒序，作为审计台账展示版本凭据 */
  const auditLog = computed(() => [...engine.commits].reverse());

  function reserve(input: ReserveInput, baseVersion: number): CommitResult {
    return engine.reserve(input, baseVersion);
  }
  function loadOrder(id: string) {
    return report(engine.load(id), "装车核销完成");
  }
  function departOrder(id: string) {
    return report(engine.depart(id), "已发车在途");
  }
  function arriveOrder(id: string) {
    return report(engine.arrive(id), "已到站并核销出库");
  }
  function cancelOrder(id: string) {
    return report(engine.cancel(id), "已撤单，预占吨数已释放");
  }
  function failOrder(id: string) {
    return report(engine.markFailed(id), "已标记在途失败，占用吨数已释放");
  }
  function simulateConcurrent(fuel: Fuel, tons: number) {
    return report(engine.simulateConcurrentReserve(fuel, tons), "并发窗口已抢先提交");
  }
  function resumeMigration() {
    return engine.resumeMigration();
  }
  function injectLegacyDemo() {
    const demo = [
      {
        id: `old-${Date.now()}-1`,
        station: "新区站",
        fuel: "95号汽油",
        tons: 20,
        arriveAt: "2026-09-15",
        status: "运输中",
        notes: "旧版窗口遗留-在途单"
      },
      {
        id: `old-${Date.now()}-2`,
        station: "城东站",
        fuel: "柴油",
        tons: 15,
        arriveAt: "2026-09-16",
        status: "待发车",
        notes: "旧版窗口遗留-待发单"
      },
      {
        id: `old-${Date.now()}-3`,
        station: "机场站",
        fuel: "92号汽油",
        tons: 9,
        arriveAt: "2026-09-14",
        status: "已到站",
        notes: "旧版窗口遗留-到站单"
      }
    ];
    localStorage.setItem("hxwlfront-19-oil-delivery", JSON.stringify(demo));
    pushToast("ok", "已放入 3 条旧版配送单，开始一次性迁移，刷新页面也只会继续剩余条目");
    void engine.resumeMigration();
  }

  return {
    state,
    toasts,
    pushToast,
    report,
    version,
    orders,
    depotCards,
    metrics,
    statusRows,
    auditLog,
    reserve,
    loadOrder,
    departOrder,
    arriveOrder,
    cancelOrder,
    failOrder,
    simulateConcurrent,
    resumeMigration,
    injectLegacyDemo
  };
});
