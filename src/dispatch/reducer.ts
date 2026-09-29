import type {
  CommitEnvelope,
  DomainEvent,
  Fuel,
  LedgerState,
  Order,
  OrderStatus
} from "./types";
import { FUELS, TERMINAL_STATUSES } from "./types";

export class LedgerError extends Error {
  constructor(public readonly code: "invalid" | "conflict", message: string) {
    super(message);
    this.name = "LedgerError";
  }
}

export function emptyDepot(): Record<Fuel, number> {
  return { "92号汽油": 0, "95号汽油": 0, 柴油: 0 };
}

export function emptyState(): LedgerState {
  return {
    version: 0,
    initialized: false,
    depot: emptyDepot(),
    orders: {},
    migration: { state: "idle", source: "", total: 0, done: 0, migratedIds: [], skipped: 0 }
  };
}

/** 当前仍占用罐容的吨数：已预占/已装车/在途 */
export function activeHold(state: LedgerState, fuel: Fuel): number {
  return Object.values(state.orders)
    .filter((order) => order.fuel === fuel && !TERMINAL_STATUSES.includes(order.status))
    .reduce((sum, order) => sum + order.tons, 0);
}

/** 已到站核销出库的吨数 */
export function consumedTons(state: LedgerState, fuel: Fuel): number {
  return Object.values(state.orders)
    .filter((order) => order.fuel === fuel && order.status === "arrived")
    .reduce((sum, order) => sum + order.tons, 0);
}

/** 油库当前可用吨数 = 总罐容 - 在途占用 - 已核销出库 */
export function availableTons(state: LedgerState, fuel: Fuel): number {
  return state.depot[fuel] - activeHold(state, fuel) - consumedTons(state, fuel);
}

function transition(order: Order, to: OrderStatus, version: number, at: string, note?: string) {
  order.history.push({ at, from: order.status, to, version, note });
  order.status = to;
}

const VALID_TRANSITIONS: Record<string, OrderStatus[]> = {
  loaded: ["reserved"],
  inTransit: ["loaded"],
  arrived: ["inTransit"],
  cancelled: ["reserved"],
  failed: ["inTransit", "loaded"]
};

/** 把单个事件纯函数地施加到状态上；seenIds 保证同事件不重复生效。 */
function applyEvent(state: LedgerState, event: DomainEvent, version: number, seenIds: Set<string>) {
  if (seenIds.has(event.id)) return;
  seenIds.add(event.id);

  switch (event.type) {
    case "depot:init": {
      if (state.initialized) return;
      state.initialized = true;
      state.depot = { ...event.stocks };
      return;
    }

    case "order:reserve": {
      const order = event.order;
      if (state.orders[order.id]) return;
      const available = availableTons(state, order.fuel);
      if (available < order.tons) {
        throw new LedgerError(
          "invalid",
          `${order.fuel}可用仅余 ${available} 吨，无法预占 ${order.tons} 吨`
        );
      }
      state.orders[order.id] = structuredClone(order);
      return;
    }

    case "order:loaded": {
      const order = state.orders[event.orderId];
      if (!order) throw new LedgerError("invalid", "配送单不存在，无法装车核销");
      if (!VALID_TRANSITIONS.loaded.includes(order.status)) {
        throw new LedgerError("invalid", `当前状态「${order.status}」不能装车核销`);
      }
      transition(order, "loaded", version, event.at, "装车核销");
      order.loadedVersion = version;
      return;
    }

    case "order:depart": {
      const order = state.orders[event.orderId];
      if (!order) throw new LedgerError("invalid", "配送单不存在，无法发车");
      if (!VALID_TRANSITIONS.inTransit.includes(order.status)) {
        throw new LedgerError("invalid", `当前状态「${order.status}」不能发车`);
      }
      transition(order, "inTransit", version, event.at, "发车在途");
      return;
    }

    case "order:arrive": {
      const order = state.orders[event.orderId];
      if (!order) throw new LedgerError("invalid", "配送单不存在，无法到站确认");
      if (!VALID_TRANSITIONS.arrived.includes(order.status)) {
        throw new LedgerError("invalid", `当前状态「${order.status}」不能确认到站`);
      }
      transition(order, "arrived", version, event.at, "到站核销出库");
      return;
    }

    case "order:release": {
      const order = state.orders[event.orderId];
      if (!order) throw new LedgerError("invalid", "配送单不存在，无法释放");
      if (!VALID_TRANSITIONS[event.to].includes(order.status)) {
        const label = event.to === "cancelled" ? "撤单" : "标记在途失败";
        throw new LedgerError("invalid", `当前状态「${order.status}」不能${label}`);
      }
      transition(
        order,
        event.to,
        version,
        event.at,
        event.to === "cancelled" ? "撤单，释放预占吨数" : "在途失败，释放占用吨数"
      );
      return;
    }

    case "migration:item": {
      // 迁移事件直接按旧单事实落账：不做可用量校验，保证历史台账不因新罐容而迁移失败。
      const order = event.order;
      if (state.orders[order.id]) return;
      state.orders[order.id] = structuredClone(order);
      state.migration.migratedIds.push(order.id);
      state.migration.done += 1;
      return;
    }

    case "migration:complete": {
      state.migration.state = "done";
      state.migration.finishedAt = event.at;
      return;
    }
  }
}

export function applyCommit(state: LedgerState, commit: CommitEnvelope, seenIds: Set<string>) {
  for (const event of commit.events) {
    applyEvent(state, event, state.version + 1, seenIds);
  }
  state.version += 1;
}

/** 从只追加日志完整重建台账（迁移中断重开时用它续跑，绝不重复扣减）。 */
export function replay(commits: CommitEnvelope[]): LedgerState {
  const state = emptyState();
  const seenIds = new Set<string>();
  for (const commit of commits) {
    applyCommit(state, commit, seenIds);
  }
  return state;
}

/** 试算：在不修改原状态的前提下回放一组事件，用于提交前校验。 */
export function withTrialEvents(state: LedgerState, events: DomainEvent[]): LedgerState {
  const trial = structuredClone(state);
  const seenIds = new Set<string>();
  for (const event of events) applyEvent(trial, event, trial.version + 1, seenIds);
  trial.version += 1;
  return trial;
}
