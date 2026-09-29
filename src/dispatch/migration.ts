/**
 * 旧版本地留存 → 新台账的一次性迁移器。
 *
 * 幂等与断点续传保证：
 * - 每张迁移单使用确定性 id（mig-<源指纹>-<序号>），并与检查点 migratedIds 在
 *   同一个台账事务中落账，崩溃在任意位置重开都只继续未完成部分；
 * - 已存在的迁移单一律跳过，capacity（罐容）只可能被扣一次；
 * - 并发两个窗口同时迁移时，后提交者收到版本冲突，重读后发现单据已被对端落账即跳过；
 * - 全部落账后才把旧键改名为归档键留存，中途关闭不会丢源数据。
 */

import {
  isFuel,
  type DispatchOrder,
  type Fuel,
  type LedgerState,
  type NewOrder,
  type OrderStatus
} from "./engine";
import {
  LEGACY_ARCHIVE_KEY,
  LEGACY_KEY,
  LedgerStorage,
  VersionConflictError,
  type KV
} from "./storage";

interface LegacyRecord {
  id?: string;
  station?: string;
  fuel?: string;
  tons?: number;
  arriveAt?: string;
  status?: string;
  notes?: string;
  createdAt?: string;
}

/** 旧版应用首次运行时的内置种子（localStorage 无旧键时视为旧版留存快照）。 */
const SEED_RECORDS: LegacyRecord[] = [
  {
    station: "城东站",
    fuel: "92号汽油",
    tons: 18,
    arriveAt: "2026-07-01",
    status: "运输中",
    notes: "车辆已出库"
  },
  {
    station: "机场站",
    fuel: "柴油",
    tons: 12,
    arriveAt: "2026-07-01",
    status: "待发车",
    notes: "等待装车"
  }
];

export interface MigrationProgress {
  phase: "idle" | "migrating" | "done";
  total: number;
  done: number;
}

export interface MigrationResult {
  migrated: number;
  skipped: string[];
  resumed: boolean;
}

/** FNV-1a 32 位指纹，仅用于迁移源识别与确定性单据 id。 */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

interface LegacySource {
  records: LegacyRecord[];
  hash: string;
  /** 旧键中的真实留存数据（迁移后需要改名归档）；种子数据无旧键可归档。 */
  raw: string | null;
  /** 已存在归档键：迁移此前已完成。 */
  archived: boolean;
}

function parseRecords(raw: string): LegacyRecord[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as LegacyRecord[]) : [];
  } catch {
    return [];
  }
}

function resolveSource(kv: KV): LegacySource {
  const archivedRaw = kv.getItem(LEGACY_ARCHIVE_KEY);
  if (archivedRaw != null) {
    return { records: [], hash: fnv1a(`archive:${archivedRaw}`), raw: null, archived: true };
  }
  const raw = kv.getItem(LEGACY_KEY);
  if (raw != null) {
    return { records: parseRecords(raw), hash: fnv1a(`raw:${raw}`), raw, archived: false };
  }
  // 与旧版行为一致：无本地数据时以内置种子作为旧版快照，仅此一次迁入。
  return {
    records: SEED_RECORDS,
    hash: fnv1a(`seed:${JSON.stringify(SEED_RECORDS)}`),
    raw: null,
    archived: false
  };
}

function mapStatus(raw: string | undefined): { status: OrderStatus; note?: string } {
  switch (raw) {
    case "待发车":
      return { status: "待装车" };
    case "运输中":
      return { status: "运输中" };
    case "已到站":
      return { status: "已到站" };
    default:
      return { status: "已撤单", note: `旧状态「${raw ?? "空"}」迁入时按已释放处理` };
  }
}

function toOrder(
  record: LegacyRecord,
  id: string,
  index: number
): { order: NewOrder | null; reason?: string } {
  if (!record.fuel || !isFuel(record.fuel)) {
    return { order: null, reason: `第 ${index + 1} 条油品无效，已跳过（不扣减罐容）` };
  }
  const tons = Number(record.tons);
  if (!(tons > 0)) {
    return { order: null, reason: `第 ${index + 1} 条吨数无效，已跳过（不扣减罐容）` };
  }
  if (!record.station?.trim()) {
    return { order: null, reason: `第 ${index + 1} 条缺少目标油站，已跳过` };
  }
  const mapped = mapStatus(record.status);
  const notes = [record.notes?.trim(), mapped.note].filter(Boolean).join("；") || "旧版迁入";
  const stamp =
    record.createdAt ?? new Date(Date.now() - (SEED_RECORDS.length - index) * 86400000).toISOString();
  return {
    order: {
      id,
      station: record.station.trim(),
      fuel: record.fuel as Fuel,
      tons,
      arriveAt: record.arriveAt ?? "",
      notes,
      status: mapped.status,
      createdAt: stamp,
      updatedAt: stamp,
      migrated: true,
      legacyId: record.id
    }
  };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 带冲突重试的提交：并发迁移时让对端已落账的单据被识别并跳过。 */
function commitWithRetry(
  storage: LedgerStorage,
  buildTxn: (state: LedgerState) => Parameters<LedgerStorage["commit"]>[0]
): LedgerState {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const state = storage.snapshot();
    try {
      return storage.commit(buildTxn(state), state.version);
    } catch (error) {
      if (!(error instanceof VersionConflictError)) throw error;
      storage.refresh();
    }
  }
  return storage.refresh();
}

/**
 * 执行（或继续）一次性迁移。可在启动时与“继续未完成迁移”按钮处重复调用：
 * 已完成直接返回，进行中只补未完成的检查点之后部分。
 */
export async function runMigration(
  storage: LedgerStorage,
  kv: KV,
  onProgress?: (progress: MigrationProgress) => void,
  stepDelay = 120
): Promise<MigrationResult> {
  const source = resolveSource(kv);
  let state = storage.refresh();
  const result: MigrationResult = { migrated: 0, skipped: [], resumed: false };

  // 归档键存在说明此前已完成；台账若因外部清库丢了迁移标记，仅补标记，绝不重新落单扣减。
  if (source.archived) {
    if (state.migration.phase !== "done") {
      state = commitWithRetry(storage, () => ({
        type: "beginMigration",
        sourceHash: source.hash,
        total: 0,
        at: new Date().toISOString()
      }));
      state = commitWithRetry(storage, () => ({
        type: "finishMigration",
        at: new Date().toISOString()
      }));
    }
    onProgress?.({ phase: "done", total: state.migration.total, done: state.migration.total });
    return result;
  }

  if (state.migration.phase === "idle") {
    state = commitWithRetry(storage, () => ({
      type: "beginMigration",
      sourceHash: source.hash,
      total: source.records.length,
      at: new Date().toISOString()
    }));
  } else if (state.migration.phase === "migrating") {
    result.resumed = true;
  }

  if (state.migration.phase === "done") {
    archiveSourceIfNeeded(kv, source);
    onProgress?.({ phase: "done", total: state.migration.total, done: state.migration.total });
    return result;
  }

  // 恢复后始终用检查点中记录的源指纹生成单据 id，保证与已落账部分对齐。
  const hash = state.migration.sourceHash || source.hash;
  const total = state.migration.total || source.records.length;

  for (let index = 0; index < source.records.length; index += 1) {
    const id = `mig-${hash}-${String(index).padStart(4, "0")}`;

    // 每轮重读检查点：崩溃重开或对端窗口先落账时，靠它跳过，绝不重复扣减。
    state = storage.refresh();
    if (state.migration.phase === "done") break;
    const already =
      state.migration.migratedIds.includes(id) || state.orders.some((order) => order.id === id);
    if (already) {
      onProgress?.({ phase: "migrating", total, done: state.migration.migratedIds.length });
      continue;
    }

    const converted = toOrder(source.records[index], id, index);
    if (!converted.order) {
      result.skipped.push(converted.reason ?? "未知原因");
      // 只推进检查点：不产生配送单、不扣减罐容，重开后不会重复处理。
      commitWithRetry(storage, () => ({
        type: "skipMigrateOrder",
        id,
        reason: converted.reason ?? "旧版数据无效"
      }));
      onProgress?.({ phase: "migrating", total, done: storage.snapshot().migration.migratedIds.length });
      if (stepDelay > 0) await delay(stepDelay);
      continue;
    }

    commitWithRetry(storage, () => ({ type: "migrateOrder", order: converted.order as NewOrder }));
    result.migrated += 1;
    onProgress?.({
      phase: "migrating",
      total,
      done: storage.snapshot().migration.migratedIds.length
    });
    if (stepDelay > 0) await delay(stepDelay);
  }

  state = storage.refresh();
  if (state.migration.phase !== "done") {
    state = commitWithRetry(storage, () => ({
      type: "finishMigration",
      at: new Date().toISOString()
    }));
  }

  archiveSourceIfNeeded(kv, source);
  onProgress?.({ phase: "done", total, done: total });
  return result;
}

/** finishMigration 已 durable 后才改名归档；崩在此前则旧键仍在，重开重走到这一步。 */
function archiveSourceIfNeeded(kv: KV, source: LegacySource): void {
  if (source.raw == null) return;
  if (kv.getItem(LEGACY_KEY) == null) return;
  kv.setItem(LEGACY_ARCHIVE_KEY, source.raw);
  kv.removeItem(LEGACY_KEY);
}

/** 供界面展示迁移单时使用的类型收窄。 */
export function isMigratedOrder(order: DispatchOrder): boolean {
  return order.migrated === true;
}
