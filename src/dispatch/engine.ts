/**
 * 调度台领域模型：
 * - 台账（LedgerState）带单调递增的版本号 version，作为乐观并发的“凭据”
 * - 每张配送单（DispatchOrder）按状态机流转，罐容占用完全由状态投影得出，
 *   不另存余量字段，从根上避免“占用被覆盖冲掉”。
 */

export const FUELS = ["92号汽油", "95号汽油", "柴油"] as const;
export type Fuel = (typeof FUELS)[number];

export function isFuel(value: string): value is Fuel {
  return (FUELS as readonly string[]).includes(value);
}

/** 派车 → 装车核销 → 在途 → 到站；派车前可撤单，在途可失败，两类终态都释放罐容。 */
export const ORDER_STATUSES = ["待装车", "运输中", "已到站", "已撤单", "在途失败"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** 仍在占用油库罐容的状态：预占、在途、已送达均扣减可用吨数。 */
const OCCUPYING: ReadonlySet<OrderStatus> = new Set<OrderStatus>(["待装车", "运输中", "已到站"]);

export const TERMINAL_STATUSES: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  "已到站",
  "已撤单",
  "在途失败"
]);

/** 允许的状态流转：装车核销 / 撤单释放 / 到站 / 在途失败释放。 */
const ALLOWED_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  待装车: ["运输中", "已撤单"],
  运输中: ["已到站", "在途失败"],
  已到站: [],
  已撤单: [],
 在途失败: []
};

export interface DispatchOrder {
  id: string;
  station: string;
  fuel: Fuel;
  tons: number;
  arriveAt: string;
  notes: string;
  status: OrderStatus;
  createdAt: string;
  updatedAt: string;
  /** 最近一次变更后的台账版本，便于单据与凭据对账。 */
  version: number;
  /** 由旧版本地留存迁移而来。 */
  migrated?: boolean;
  legacyId?: string;
}

export type NewOrder = Omit<DispatchOrder, "version">;

export type MigrationPhase = "idle" | "migrating" | "done";

export interface MigrationState {
  phase: MigrationPhase;
  /** 旧版数据源内容指纹，换源后可识别。 */
  sourceHash: string;
  total: number;
  /** 已落账的迁移单 id（断点续传的检查点）。 */
  migratedIds: string[];
  startedAt: string | null;
  finishedAt: string | null;
}

export interface LedgerState {
  /** 乐观锁版本凭据，每次成功提交 +1，初始为 1（空账凭据）。 */
  version: number;
  totals: Record<Fuel, number>;
  orders: DispatchOrder[];
  migration: MigrationState;
}

export type Txn =
  | { type: "reserve"; order: NewOrder }
  | { type: "advance"; id: string; to: OrderStatus; at: string }
  | { type: "beginMigration"; sourceHash: string; total: number; at: string }
  | { type: "migrateOrder"; order: NewOrder }
  | { type: "skipMigrateOrder"; id: string; reason: string }
  | { type: "finishMigration"; at: string };

/** 各油品罐容（吨），旧版种子数据量很小，余量足够一次迁入。 */
export const DEFAULT_TOTALS: Record<Fuel, number> = {
  "92号汽油": 240,
  "95号汽油": 200,
  柴油: 200
};

export function createInitialState(totals: Record<Fuel, number> = DEFAULT_TOTALS): LedgerState {
  return {
    version: 1,
    totals: { ...totals },
    orders: [],
    migration: {
      phase: "idle",
      sourceHash: "",
      total: 0,
      migratedIds: [],
      startedAt: null,
      finishedAt: null
    }
  };
}

export class RuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuleError";
  }
}

export function canAdvance(from: OrderStatus, to: OrderStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/** 单据当前占用的吨数；撤单 / 在途失败后为 0（即“释放”）。 */
export function occupiedTons(order: DispatchOrder): number {
  return OCCUPYING.has(order.status) ? order.tons : 0;
}

export interface FuelView {
  fuel: Fuel;
  total: number;
  reserved: number;
  inTransit: number;
  delivered: number;
  occupied: number;
  available: number;
  occupationRate: number;
}

export function fuelView(state: LedgerState, fuel: Fuel): FuelView {
  let reserved = 0;
  let inTransit = 0;
  let delivered = 0;
  for (const order of state.orders) {
    if (order.fuel !== fuel) continue;
    if (order.status === "待装车") reserved += order.tons;
    else if (order.status === "运输中") inTransit += order.tons;
    else if (order.status === "已到站") delivered += order.tons;
  }
  const total = state.totals[fuel];
  const occupied = reserved + inTransit + delivered;
  return {
    fuel,
    total,
    reserved,
    inTransit,
    delivered,
    occupied,
    available: total - occupied,
    occupationRate: total > 0 ? occupied / total : 0
  };
}

export function findOrder(state: LedgerState, id: string): DispatchOrder | undefined {
  return state.orders.find((order) => order.id === id);
}

/** 提交前的业务校验；任何失败都不产生写入。 */
export function validateTxn(state: LedgerState, txn: Txn): void {
  switch (txn.type) {
    case "reserve":
    case "migrateOrder": {
      const order = txn.order;
      if (!isFuel(order.fuel)) throw new RuleError("油品类型无效");
      if (!(order.tons > 0)) throw new RuleError("配送吨数必须大于 0");
      if (!order.station.trim()) throw new RuleError("目标油站不能为空");
      const view = fuelView(state, order.fuel);
      if (view.available < order.tons) {
        throw new RuleError(
          `${order.fuel}可用罐容不足：当前可用 ${view.available} 吨，本次需要 ${order.tons} 吨`
        );
      }
      if (txn.type === "migrateOrder") {
        if (state.migration.phase !== "migrating") {
          throw new RuleError("迁移未开始或已结束，不能写入迁移单");
        }
        if (findOrder(state, order.id)) {
          throw new RuleError(`迁移单 ${order.id} 已存在，禁止重复扣减`);
        }
        if (state.migration.migratedIds.includes(order.id)) {
          throw new RuleError(`迁移单 ${order.id} 已在检查点中，禁止重复扣减`);
        }
      } else if (findOrder(state, order.id)) {
        throw new RuleError(`配送单 ${order.id} 已存在`);
      }
      return;
    }
    case "skipMigrateOrder": {
      if (state.migration.phase !== "migrating") {
        throw new RuleError("迁移未开始或已结束，不能推进检查点");
      }
      if (state.migration.migratedIds.includes(txn.id) || findOrder(state, txn.id)) {
        throw new RuleError(`迁移项 ${txn.id} 已处理，禁止重复推进检查点`);
      }
      return;
    }
    case "advance": {
      const order = findOrder(state, txn.id);
      if (!order) throw new RuleError("配送单不存在或已被其他窗口处理");
      if (!canAdvance(order.status, txn.to)) {
        throw new RuleError(`不允许从「${order.status}」流转到「${txn.to}」`);
      }
      return;
    }
    case "beginMigration": {
      if (state.migration.phase !== "idle") {
        throw new RuleError("迁移已经开始，不能重复发起");
      }
      return;
    }
    case "finishMigration": {
      if (state.migration.phase !== "migrating") {
        throw new RuleError("没有进行中的迁移");
      }
      return;
    }
  }
}

/**
 * 纯函数状态机：校验通过后产出新版本台账。
 * 占用 / 释放全部体现为单据状态变化，投影时自然增减，不存在可被覆盖的余量字段。
 */
export function applyTxn(state: LedgerState, txn: Txn): LedgerState {
  validateTxn(state, txn);
  const nextVersion = state.version + 1;

  switch (txn.type) {
    case "reserve":
    case "migrateOrder": {
      const order: DispatchOrder = { ...txn.order, version: nextVersion };
      const migration =
        txn.type === "migrateOrder"
          ? {
              ...state.migration,
              migratedIds: [...state.migration.migratedIds, order.id]
            }
          : state.migration;
      return {
        ...state,
        version: nextVersion,
        orders: [order, ...state.orders],
        migration
      };
    }
    case "advance": {
      const orders = state.orders.map((order) =>
        order.id === txn.id
          ? { ...order, status: txn.to, updatedAt: txn.at, version: nextVersion }
          : order
      );
      return { ...state, version: nextVersion, orders };
    }
    case "skipMigrateOrder":
      // 只推进检查点，不产生配送单、不触碰罐容。
      return {
        ...state,
        version: nextVersion,
        migration: {
          ...state.migration,
          migratedIds: [...state.migration.migratedIds, txn.id]
        }
      };
    case "beginMigration":
      return {
        ...state,
        version: nextVersion,
        migration: {
          phase: "migrating",
          sourceHash: txn.sourceHash,
          total: txn.total,
          migratedIds: [],
          startedAt: txn.at,
          finishedAt: null
        }
      };
    case "finishMigration":
      return {
        ...state,
        version: nextVersion,
        migration: { ...state.migration, phase: "done", finishedAt: txn.at }
      };
  }
}
