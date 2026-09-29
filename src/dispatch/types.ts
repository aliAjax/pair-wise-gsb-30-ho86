// 调度台领域模型：一切状态都由只追加的事件日志推导，不允许原地覆盖。

export const FUELS = ["92号汽油", "95号汽油", "柴油"] as const;
export type Fuel = (typeof FUELS)[number];

export const STATIONS = ["城东站", "机场站", "新区站"] as const;
export type Station = (typeof STATIONS)[number];

/** 配送单生命周期状态 */
export type OrderStatus =
  | "reserved" // 已预占（派车前从油库可用吨数中预占）
  | "loaded" // 已装车（装车核销，占用保留）
  | "inTransit" // 在途
  | "arrived" // 已到站（吨数真正核销出库）
  | "cancelled" // 已撤单（释放预占）
  | "failed"; // 在途失败（释放占用）

export const STATUS_LABEL: Record<OrderStatus, string> = {
  reserved: "已预占",
  loaded: "已装车",
  inTransit: "在途",
  arrived: "已到站",
  cancelled: "已撤单",
  failed: "在途失败"
};

/** 终态：不再占用油库吨数 */
export const TERMINAL_STATUSES: readonly OrderStatus[] = ["arrived", "cancelled", "failed"];

export interface OrderHistoryEntry {
  at: string;
  from: OrderStatus | null;
  to: OrderStatus;
  /** 该次流转落账后的台账版本，即版本凭据 */
  version: number;
  note?: string;
}

export interface Order {
  id: string;
  station: Station;
  fuel: Fuel;
  tons: number;
  arriveAt: string;
  status: OrderStatus;
  notes: string;
  createdAt: string;
  /** 预占落账版本 */
  reservedVersion: number;
  /** 装车核销版本 */
  loadedVersion?: number;
  history: OrderHistoryEntry[];
  /** 迁移自旧版配送单 */
  migrated?: boolean;
}

interface EventBase {
  /** 事件幂等凭据：同一事件重放不会重复扣减 */
  id: string;
}

export type DomainEvent =
  | (EventBase & {
      type: "depot:init";
      stocks: Record<Fuel, number>;
      reason: "fresh" | "migration";
      source?: string;
      total?: number;
      skipped?: number;
    })
  | (EventBase & { type: "order:reserve"; order: Order })
  | (EventBase & { type: "order:loaded"; orderId: string; at: string })
  | (EventBase & { type: "order:depart"; orderId: string; at: string })
  | (EventBase & { type: "order:arrive"; orderId: string; at: string })
  | (EventBase & {
      type: "order:release";
      orderId: string;
      to: "cancelled" | "failed";
      at: string;
    })
  | (EventBase & { type: "migration:item"; order: Order })
  | (EventBase & {
      type: "migration:complete";
      at: string;
      total: number;
      skipped: number;
    });

/** 一次提交 = 一个版本凭据，其中包含的事件原子落账 */
export interface CommitEnvelope {
  id: string;
  at: string;
  expectedVersion: number;
  label: string;
  events: DomainEvent[];
}

export interface MigrationState {
  state: "idle" | "running" | "done";
  source: string;
  total: number;
  done: number;
  migratedIds: string[];
  skipped: number;
  finishedAt?: string;
}

export interface LedgerState {
  version: number;
  initialized: boolean;
  /** 油库初始/总罐容（按油品） */
  depot: Record<Fuel, number>;
  orders: Record<string, Order>;
  migration: MigrationState;
}

/** 预占派车入参 */
export interface ReserveInput {
  station: Station;
  fuel: Fuel;
  tons: number;
  arriveAt: string;
  notes: string;
}

export type CommitResult =
  | { ok: true; version: number }
  | { ok: false; reason: "conflict" | "invalid"; message: string; currentVersion: number };

/** 旧版本地留存里的配送单格式 */
export interface LegacyRecord {
  id?: string;
  station?: unknown;
  fuel?: unknown;
  tons?: unknown;
  arriveAt?: unknown;
  status?: unknown;
  notes?: unknown;
  createdAt?: unknown;
  [key: string]: unknown;
}
