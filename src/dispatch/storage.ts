/**
 * 版本化台账存储：
 * - stateKey 保存当前已提交台账快照；
 * - walKey 是两阶段提交的“凭据信封”，先于快照落盘。
 *   页面在任何一步关闭，重开时按 空 → 有WAL 两档重放，单据与台账永远同进同退；
 * - expectedVersion 实现乐观锁：后提交者若凭据落后会被拒绝，拿到的仍是完整新台账，
 *   不会覆盖前一个窗口的罐容占用。
 */

import {
  applyTxn,
  createInitialState,
  type LedgerState,
  type Txn
} from "./engine";

export interface KV {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const STATE_KEY = "hxwlfront-19-dispatch-ledger-v2";
export const WAL_KEY = "hxwlfront-19-dispatch-wal-v2";

/** 旧版整份覆盖式配送单（迁移数据源）。 */
export const LEGACY_KEY = "hxwlfront-19-oil-delivery";
/** 迁移完成后旧数据改键留存，不再被当数据源。 */
export const LEGACY_ARCHIVE_KEY = "hxwlfront-19-oil-delivery.archived";

export class VersionConflictError extends Error {
  constructor(
    public expected: number,
    public actual: number
  ) {
    super(`台账版本已变化（你持有的是 v${expected}，当前为 v${actual}），请按最新占用情况重试`);
    this.name = "VersionConflictError";
  }
}

interface WalEnvelope {
  /** 本次提交所基于的版本凭据。 */
  baseVersion: number;
  /** 待重放事务；恢复时幂等重放（校验保证重复落账会被拒绝）。 */
  txn: Txn;
  nonce: string;
  createdAt: string;
}

function nonce(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 启动恢复：空 → WAL 两档补齐，返回最终台账。任何中途崩溃重开结果一致。 */
export function bootstrap(kv: KV): LedgerState {
  const state = readState(kv);
  const rawWal = kv.getItem(WAL_KEY);
  if (!rawWal) return state;

  const wal = parseWal(rawWal);
  if (!wal) {
    // WAL 损坏无法重放，台账快照仍是最后一个一致点，丢弃残信继续。
    kv.removeItem(WAL_KEY);
    return state;
  }
  if (state.version === wal.baseVersion) {
    // 崩在“WAL 已落盘、快照未更新”：补提交。
    const next = applyTxn(state, wal.txn);
    kv.setItem(STATE_KEY, serializeState(next));
  }
  // 快照已领先（崩在最后一步）：清理残留 WAL。
  kv.removeItem(WAL_KEY);
  return readState(kv);
}

export class LedgerStorage {
  state: LedgerState;

  constructor(private kv: KV, initial?: LedgerState) {
    this.state = initial ?? bootstrap(kv);
  }

  /**
   * 带版本凭据的原子提交：
   * 1) 凭据落后 → VersionConflictError，调用方保留草稿、刷新占用后重试；
   * 2) 先写 WAL（含 baseVersion）；
   * 3) 再写快照；
   * 4) 最后清 WAL。
   * 任意一步中断都由下次 bootstrap 补齐，不会“各留一半”。
   */
  commit(txn: Txn, expectedVersion: number): LedgerState {
    const fresh = bootstrap(this.kv);
    if (fresh.version !== expectedVersion) {
      this.state = fresh;
      throw new VersionConflictError(expectedVersion, fresh.version);
    }
    // 先在内存校验，业务不合法绝不落 WAL。
    const next = applyTxn(fresh, txn);

    const envelope: WalEnvelope = {
      baseVersion: expectedVersion,
      txn,
      nonce: nonce(),
      createdAt: new Date().toISOString()
    };
    this.kv.setItem(WAL_KEY, JSON.stringify(envelope));
    this.kv.setItem(STATE_KEY, serializeState(next));
    this.kv.removeItem(WAL_KEY);

    this.state = next;
    return clone(next);
  }

  /** 从存储重读（其他窗口已提交时用），顺带清理可能的残留 WAL。 */
  refresh(): LedgerState {
    this.state = bootstrap(this.kv);
    return clone(this.state);
  }

  snapshot(): LedgerState {
    return clone(this.state);
  }
}

function readState(kv: KV): LedgerState {
  const raw = kv.getItem(STATE_KEY);
  if (!raw) return createInitialState();
  try {
    const parsed = JSON.parse(raw) as Partial<LedgerState>;
    return normalizeState(parsed);
  } catch {
    return createInitialState();
  }
}

/** 旧版本字段缺失时按初始台账补齐，避免半份数据导致投影出错。 */
function normalizeState(raw: Partial<LedgerState>): LedgerState {
  const base = createInitialState();
  return {
    version: typeof raw.version === "number" && raw.version >= 1 ? raw.version : base.version,
    totals: { ...base.totals, ...(raw.totals ?? {}) },
    orders: Array.isArray(raw.orders) ? (raw.orders as LedgerState["orders"]) : [],
    migration: { ...base.migration, ...(raw.migration ?? {}) }
  };
}

function serializeState(state: LedgerState): string {
  return JSON.stringify(state);
}

function parseWal(raw: string): WalEnvelope | null {
  try {
    const parsed = JSON.parse(raw) as WalEnvelope;
    if (typeof parsed.baseVersion !== "number" || !parsed.txn) return null;
    return parsed;
  } catch {
    return null;
  }
}
