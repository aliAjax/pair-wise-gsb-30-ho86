import {
  applyCommit,
  emptyState,
  LedgerError,
  replay
} from "./reducer";
import type {
  CommitEnvelope,
  CommitResult,
  DomainEvent,
  Fuel,
  LegacyRecord,
  LedgerState,
  Order,
  OrderStatus,
  ReserveInput
} from "./types";
import { FUELS, STATUS_LABEL, STATIONS } from "./types";

const LOG_KEY = "hxwlfront-19-dispatch-log";
const LEGACY_KEY = "hxwlfront-19-oil-delivery";

/** 新台账启用时的油库罐容（吨） */
export const INITIAL_STOCKS: Record<Fuel, number> = {
  "92号汽油": 120,
  "95号汽油": 90,
  柴油: 100
};

export function uid(prefix = "id"): string {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}-${random}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function readLog(): CommitEnvelope[] {
  const raw = localStorage.getItem(LOG_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as CommitEnvelope[]) : [];
  } catch {
    return [];
  }
}

/** 整份提交日志一次写入：要么完整可见，要么页面关闭后仍停留在上一版本，不会各留一半。 */
function writeLog(log: CommitEnvelope[]) {
  localStorage.setItem(LOG_KEY, JSON.stringify(log));
}

type ChangeListener = (state: LedgerState) => void;

export class DispatchEngine {
  private log: CommitEnvelope[] = [];
  state: LedgerState = emptyState();
  private seenIds = new Set<string>();
  private listeners = new Set<ChangeListener>();

  constructor() {
    this.bootstrap();
    window.addEventListener("storage", (event) => {
      // 其它窗口写入后，本窗口只追加自己缺失的提交，版本凭据随之推进
      if (event.key === LOG_KEY && event.newValue !== null) {
        this.reloadFromStorage();
      }
    });
  }

  subscribe(fn: ChangeListener): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const fn of this.listeners) fn(this.state);
  }

  private reloadFromStorage() {
    const onDisk = readLog();
    if (onDisk.length <= this.log.length) return;
    this.ingest(onDisk);
  }

  // ---- 启动引导 ---------------------------------------------------------

  private bootstrap() {
    this.log = readLog();
    const hasUnfinishedMigration = localStorage.getItem(LEGACY_KEY) !== null;
    if (this.log.length > 0) {
      this.state = replay(this.log);
      this.rebuildSeenIds();
      // 上次迁移被页面关闭打断（旧 key 尚未归档移除）：重开只续跑剩余旧单
      if (this.state.initialized && hasUnfinishedMigration) {
        void this.resumeMigration();
      }
      return;
    }

    // 空台账：若存在旧版本地留存，先建罐容再迁移；否则写入演示台账
    const legacy = this.readLegacy();
    if (legacy.length > 0) {
      this.commit(
        [
          {
            id: uid("evt"),
            type: "depot:init",
            stocks: { ...INITIAL_STOCKS },
            reason: "migration",
            source: LEGACY_KEY,
            total: legacy.length,
            skipped: 0
          }
        ],
        "初始化油库罐容（迁移旧配送单）",
        0
      );
      void this.resumeMigration();
    } else {
      this.seedFresh();
    }
  }

  private rebuildSeenIds() {
    this.seenIds = new Set<string>();
    for (const commit of this.log) for (const event of commit.events) this.seenIds.add(event.id);
  }

  private seedFresh() {
    const makeOrder = (
      index: number,
      partial: Pick<Order, "station" | "fuel" | "tons" | "arriveAt" | "status" | "notes">,
      daysAgo: number
    ): Order => {
      const createdAt = new Date(Date.now() - daysAgo * 86400000).toISOString();
      return {
        id: `seed-${index + 1}`,
        createdAt,
        reservedVersion: 0,
        history: [],
        ...partial,
        notes: partial.notes
      };
    };
    const draftOrders: Order[] = [
      makeOrder(0, {
        station: "城东站",
        fuel: "92号汽油",
        tons: 18,
        arriveAt: "2026-10-02",
        status: "inTransit",
        notes: "车辆已出库"
      }, 1),
      makeOrder(1, {
        station: "机场站",
        fuel: "柴油",
        tons: 12,
        arriveAt: "2026-10-02",
        status: "reserved",
        notes: "等待装车"
      }, 0)
    ];

    // 预占在提交时仍会走可用量校验，确保演示台账自身占用自洽
    this.commit(
      [
        { id: uid("evt"), type: "depot:init", stocks: { ...INITIAL_STOCKS }, reason: "fresh" },
        ...draftOrders.map((order) => {
          order.reservedVersion = 1; // 与 depot:init 同属首个版本
          order.history.push({
            at: order.createdAt,
            from: null,
            to: "reserved",
            version: 1
          });
          if (order.status === "inTransit") {
            order.loadedVersion = 1;
            order.history.push(
              { at: order.createdAt, from: "reserved", to: "loaded", version: 1 },
              { at: order.createdAt, from: "loaded", to: "inTransit", version: 1 }
            );
          }
          return { id: uid("evt"), type: "order:reserve" as const, order };
        })
      ],
      "初始化油库与示例配送单",
      0
    );
  }

  // ---- 乐观并发提交 ------------------------------------------------------

  /**
   * 原子提交：expectedVersion 即调用方手里的版本凭据。
   * 写入前同步重读磁盘日志——其它窗口已先行提交时磁盘版本更长，
   * 本窗口判定冲突、补齐对方提交后返回，调用方保留草稿并刷新占用重试。
   */
  commit(events: DomainEvent[], label: string, expectedVersion = this.state.version): CommitResult {
    const onDisk = readLog();
    if (onDisk.length !== expectedVersion) {
      // 磁盘已被其它窗口推进：先把缺失的提交追加进本窗口，再报冲突
      if (onDisk.length > this.log.length) this.ingest(onDisk);
      return {
        ok: false,
        reason: "conflict",
        message: `台账版本已变化（你的依据 v${expectedVersion}，当前 v${onDisk.length}），请核对最新占用后重试`,
        currentVersion: onDisk.length
      };
    }
    try {
      // 在临时状态上顺序试算：库存不足等业务错误不落半条账；
      // 同批内后面的事件能看到前面事件的占用。
      const trial = structuredClone(this.state);
      const seen = new Set(this.seenIds);
      for (const event of events) {
        applyCommit(trial, { id: uid("cmt-trial"), at: nowIso(), expectedVersion, events: [event], label }, seen);
      }
    } catch (error) {
      const message = error instanceof LedgerError ? error.message : "提交校验失败";
      return { ok: false, reason: "invalid", message, currentVersion: this.state.version };
    }

    const envelope: CommitEnvelope = {
      id: uid("cmt"),
      at: nowIso(),
      expectedVersion,
      label,
      events
    };
    const nextLog = [...this.log, envelope];
    writeLog(nextLog); // 单次 localStorage 写入 = 原子落账
    this.log = nextLog;
    applyCommit(this.state, envelope, this.seenIds);
    this.emit();
    return { ok: true, version: this.state.version };
  }

  /** 把磁盘上比本窗口更新的提交追加进来并刷新状态 */
  private ingest(onDisk: CommitEnvelope[]) {
    const appended = onDisk.slice(this.log.length);
    for (const commit of appended) applyCommit(this.state, commit, this.seenIds);
    this.log = onDisk;
    this.emit();
  }

  // ---- 派车业务动作 ------------------------------------------------------

  reserve(input: ReserveInput, baseVersion: number): CommitResult {
    const at = nowIso();
    const order: Order = {
      id: uid("order"),
      station: input.station,
      fuel: input.fuel,
      tons: input.tons,
      arriveAt: input.arriveAt,
      status: "reserved",
      notes: input.notes || "暂无备注",
      createdAt: at,
      reservedVersion: baseVersion + 1,
      history: [{ at, from: null, to: "reserved", version: baseVersion + 1 }]
    };
    return this.commit([{ id: uid("evt"), type: "order:reserve", order }], `派车预占 ${input.tons} 吨${input.fuel}`, baseVersion);
  }

  load(orderId: string): CommitResult {
    return this.commit(
      [{ id: uid("evt"), type: "order:loaded", orderId, at: nowIso() }],
      "装车核销",
      this.state.version
    );
  }

  depart(orderId: string): CommitResult {
    return this.commit(
      [{ id: uid("evt"), type: "order:depart", orderId, at: nowIso() }],
      "发车在途",
      this.state.version
    );
  }

  arrive(orderId: string): CommitResult {
    return this.commit(
      [{ id: uid("evt"), type: "order:arrive", orderId, at: nowIso() }],
      "到站核销出库",
      this.state.version
    );
  }

  /** 撤单（仅已预占可撤）：预占吨数释放回油库可用量 */
  cancel(orderId: string): CommitResult {
    return this.commit(
      [{ id: uid("evt"), type: "order:release", orderId, to: "cancelled", at: nowIso() }],
      "撤单并释放预占",
      this.state.version
    );
  }

  /** 在途失败：装车后/在途失败，占用吨数释放 */
  markFailed(orderId: string): CommitResult {
    return this.commit(
      [{ id: uid("evt"), type: "order:release", orderId, to: "failed", at: nowIso() }],
      "在途失败并释放占用",
      this.state.version
    );
  }

  // ---- 旧版数据迁移（可中断、可续跑、不重复扣减） -------------------------

  readLegacy(): LegacyRecord[] {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? (parsed as LegacyRecord[]) : [];
    } catch {
      return [];
    }
  }

  private normalizeLegacy(record: LegacyRecord, index: number, version: number): Order | null {
    const fuel = String(record.fuel ?? "");
    const station = String(record.station ?? "");
    const tons = Number(record.tons);
    if (
      !FUELS.includes(fuel as Fuel) ||
      !(STATIONS as readonly string[]).includes(station) ||
      !Number.isFinite(tons) ||
      tons <= 0
    ) {
      return null;
    }
    const at = typeof record.createdAt === "string" ? record.createdAt : nowIso();
    const legacyStatus = String(record.status ?? "");
    const status = this.mapLegacyStatus(legacyStatus);
    const history: Order["history"] = [{ at, from: null, to: "reserved", version, note: "旧版配送单迁移" }];
    if (status === "loaded" || status === "inTransit" || status === "arrived" || status === "failed") {
      history.push({ at, from: "reserved", to: "loaded", version });
    }
    if (status === "inTransit" || status === "arrived" || status === "failed") {
      history.push({ at, from: "loaded", to: "inTransit", version });
    }
    if (status === "arrived") history.push({ at, from: "inTransit", to: "arrived", version });
    if (status === "failed") history.push({ at, from: "inTransit", to: "failed", version });
    if (status === "cancelled") {
      history.length = 0;
      history.push(
        { at, from: null, to: "reserved", version, note: "旧版配送单迁移" },
        { at, from: "reserved", to: "cancelled", version }
      );
    }

    return {
      id: typeof record.id === "string" && record.id ? `legacy-${record.id}` : `legacy-seed-${index + 1}`,
      station: station as Order["station"],
      fuel: fuel as Fuel,
      tons,
      arriveAt: String(record.arriveAt ?? ""),
      status,
      notes: typeof record.notes === "string" ? record.notes : "旧版迁移",
      createdAt: at,
      reservedVersion: version,
      loadedVersion: ["loaded", "inTransit", "arrived", "failed"].includes(status) ? version : undefined,
      history,
      migrated: true
    };
  }

  private mapLegacyStatus(status: string): OrderStatus {
    if (status === "运输中") return "inTransit";
    if (status === "已到站") return "arrived";
    return "reserved";
  }

  /**
   * 迁移断点完全由事件日志推导：已落账的 migration:item 不会被二次提交，
   * 中断重开时只处理剩余旧单。每条旧单独立提交，中断最多丢“正在处理的那一条”。
   */
  async resumeMigration(): Promise<void> {
    if (!this.state.initialized || this.state.migration.state === "done") return;
    const legacy = this.readLegacy();
    const migrated = new Set(this.state.migration.migratedIds);

    this.state.migration.state = "running";
    this.state.migration.source = LEGACY_KEY;
    this.state.migration.total = legacy.length;
    this.emit();

    for (let index = 0; index < legacy.length; index += 1) {
      // 每次循环重新读状态：页面重开、或并发窗口都可能已推进版本
      const record = legacy[index];
      const fallbackId =
        typeof record.id === "string" && record.id ? `legacy-${record.id}` : `legacy-seed-${index + 1}`;
      if (migrated.has(fallbackId)) continue;

      const order = this.normalizeLegacy(record, index, this.state.version + 1);
      if (!order) {
        // 无法识别的旧单计入跳过，不参与扣减
        this.state.migration.skipped += 1;
        continue;
      }

      const result = this.commit(
        [{ id: uid("evt"), type: "migration:item", order }],
        `迁移旧配送单 ${order.station}/${order.fuel}`,
        this.state.version
      );
      if (result.ok) {
        migrated.add(order.id);
        await new Promise((resolve) => window.setTimeout(resolve, 150));
      } else if (result.reason === "invalid") {
        this.state.migration.skipped += 1;
        this.emit();
      }
      // conflict 分支理论上不会出现（migration 串行），出现则等下次重开续跑
    }

    if (this.state.migration.done + this.state.migration.skipped >= this.state.migration.total) {
      this.commit(
        [
          {
            id: uid("evt"),
            type: "migration:complete",
            at: nowIso(),
            total: this.state.migration.total,
            skipped: this.state.migration.skipped
          }
        ],
        "旧版配送单迁移完成",
        this.state.version
      );
      // 迁移完成后把旧留存改名归档（原 key 不再出现，避免以后被重复迁移）
      const raw = localStorage.getItem(LEGACY_KEY);
      if (raw !== null) {
        localStorage.setItem(`${LEGACY_KEY}-archived-${Date.now()}`, raw);
        localStorage.removeItem(LEGACY_KEY);
      }
    }
  }

  get migrationPending(): boolean {
    return this.state.migration.state === "running";
  }

  /** 只读审计日志（倒序） */
  get commits(): readonly CommitEnvelope[] {
    return this.log;
  }

  // ---- 测试辅助 ---------------------------------------------------------

  /** 模拟另一个窗口抢先提交一次预占（用于演示版本冲突与占用变化）。 */
  simulateConcurrentReserve(fuel: Fuel, tons: number): CommitResult {
    const at = nowIso();
    const order: Order = {
      id: uid("concurrent"),
      station: "新区站",
      fuel,
      tons,
      arriveAt: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
      status: "reserved",
      notes: "另一调度窗口抢先派车",
      createdAt: at,
      reservedVersion: this.state.version + 1,
      history: [{ at, from: null, to: "reserved", version: this.state.version + 1 }]
    };
    return this.commit(
      [{ id: uid("evt"), type: "order:reserve", order }],
      `并发窗口预占 ${tons} 吨${fuel}`,
      this.state.version
    );
  }
}

export const engine = new DispatchEngine();
export { FUELS, STATIONS, STATUS_LABEL };
