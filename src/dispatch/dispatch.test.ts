import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyTxn,
  canAdvance,
  createInitialState,
  findOrder,
  fuelView,
  RuleError,
  type LedgerState,
  type NewOrder
} from "./engine";
import {
  LEGACY_ARCHIVE_KEY,
  LEGACY_KEY,
  STATE_KEY,
  VersionConflictError,
  WAL_KEY,
  bootstrap,
  LedgerStorage,
  type KV
} from "./storage";
import { runMigration } from "./migration";

/** 内存版 KV，模拟 localStorage（可模拟“写到一半页面关闭”）。 */
class MemoryKV implements KV {
  private map = new Map<string, string>();
  /** 写到第 n 次 setItem 后抛错，模拟断电/页面关闭。 */
  crashAfterSets = Infinity;
  private sets = 0;

  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.sets += 1;
    this.map.set(key, value);
    if (this.sets >= this.crashAfterSets) throw new Error("CRASH");
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  dump(): Record<string, string> {
    return Object.fromEntries(this.map);
  }
  load(dump: Record<string, string>): void {
    this.map = new Map(Object.entries(dump));
  }
  get size(): number {
    return this.map.size;
  }
}

function order(partial: Partial<NewOrder> & Pick<NewOrder, "fuel" | "tons">): NewOrder {
  const now = new Date().toISOString();
  return {
    id: `o-${Math.random().toString(36).slice(2)}`,
    station: "城东站",
    arriveAt: "2026-10-01",
    notes: "测试单",
    status: "待装车",
    createdAt: now,
    updatedAt: now,
    ...partial
  };
}

test("预占扣减可用吨数；装车核销不改占用；撤单/在途失败释放；到站保留占用", () => {
  let state = createInitialState();
  const reserve = order({ fuel: "92号汽油", tons: 30 });

  state = applyTxn(state, { type: "reserve", order: reserve });
  assert.equal(fuelView(state, "92号汽油").reserved, 30);
  assert.equal(fuelView(state, "92号汽油").available, 210);

  state = applyTxn(state, { type: "advance", id: reserve.id, to: "运输中", at: new Date().toISOString() });
  assert.equal(fuelView(state, "92号汽油").reserved, 0);
  assert.equal(fuelView(state, "92号汽油").inTransit, 30);
  assert.equal(fuelView(state, "92号汽油").available, 210);

  // 撤单后的单与到站单对比
  const cancel = order({ fuel: "92号汽油", tons: 20, station: "机场站" });
  state = applyTxn(state, { type: "reserve", order: cancel });
  state = applyTxn(state, { type: "advance", id: cancel.id, to: "已撤单", at: new Date().toISOString() });
  assert.equal(fuelView(state, "92号汽油").available, 210, "撤单释放预占");

  state = applyTxn(state, { type: "advance", id: reserve.id, to: "已到站", at: new Date().toISOString() });
  assert.equal(fuelView(state, "92号汽油").delivered, 30);
  assert.equal(fuelView(state, "92号汽油").available, 210, "已到站仍占用（已交付的库存）");

  // 在途失败释放
  const failed = order({ fuel: "柴油", tons: 50, station: "新区站" });
  state = applyTxn(state, { type: "reserve", order: failed });
  state = applyTxn(state, { type: "advance", id: failed.id, to: "运输中", at: new Date().toISOString() });
  state = applyTxn(state, { type: "advance", id: failed.id, to: "在途失败", at: new Date().toISOString() });
  assert.equal(fuelView(state, "柴油").available, 200, "在途失败释放占用");

  // 非法流转被拒
  assert.equal(canAdvance("已到站", "运输中"), false);
  assert.throws(
    () => applyTxn(state, { type: "advance", id: failed.id, to: "运输中", at: "" }),
    RuleError
  );
});

test("预占超过可用吨数被拒，台账版本不前进、不产生单据", () => {
  const state = createInitialState();
  const huge = order({ fuel: "柴油", tons: 9999 });
  assert.throws(() => applyTxn(state, { type: "reserve", order: huge }), RuleError);
  assert.equal(state.version, 1);
  assert.equal(state.orders.length, 0);
});

test("乐观锁：凭据落后的提交被拒且不覆盖先提交者的占用，重读后可重试成功", () => {
  const kv = new MemoryKV();
  const windowA = new LedgerStorage(kv);
  const windowB = new LedgerStorage(kv);

  // 两窗口同时读到 v1，各自安排同油品
  const orderA = order({ fuel: "92号汽油", tons: 100 });
  const orderB = order({ fuel: "92号汽油", tons: 80, station: "机场站" });

  windowA.commit({ type: "reserve", order: orderA }, 1);

  // B 持旧凭据 v1 提交 -> 冲突，占用没有被冲掉
  assert.throws(
    () => windowB.commit({ type: "reserve", order: orderB }, 1),
    VersionConflictError
  );

  // 模拟两个 KV 共享同一底层存储
  const shared = new MemoryKV();
  const a = new LedgerStorage(shared);
  const b = new LedgerStorage(shared);
  a.commit({ type: "reserve", order: orderA }, 1);
  assert.throws(() => b.commit({ type: "reserve", order: orderB }, 1), VersionConflictError);
  // B 看到占用已变化：A 的 100 吨还在
  assert.equal(fuelView(b.state, "92号汽油").occupied, 100);
  // B 保留自己的草稿，把吨数改成可行数量后基于新版本重试成功
  const relaxed = { ...orderB, tons: 50 };
  b.commit({ type: "reserve", order: relaxed }, b.state.version);
  assert.equal(fuelView(b.state, "92号汽油").occupied, 150);
  assert.equal(b.state.version, 3);
  assert.ok(findOrder(b.state, orderA.id), "先提交者的单据仍在");
});

test("台账凭据是整份台账版本：期间别的单据提交后，持旧凭据流转单据被拒", () => {
  const kv = new MemoryKV();
  const store = new LedgerStorage(kv);
  const first = order({ fuel: "92号汽油", tons: 10 });
  const second = order({ fuel: "柴油", tons: 20, station: "机场站" });
  store.commit({ type: "reserve", order: first }, 1); // -> v2
  store.commit({ type: "reserve", order: second }, 2); // -> v3

  // 另一个窗口停留在 v2，想对 first 装车核销；即使该单据存在也必须先看到 v3
  const stale = new LedgerStorage(kv);
  assert.throws(
    () =>
      stale.commit(
        { type: "advance", id: first.id, to: "运输中", at: new Date().toISOString() },
        2
      ),
    VersionConflictError
  );
  // 刷新凭据后流转成功，预占转为在途
  stale.refresh();
  stale.commit(
    { type: "advance", id: first.id, to: "运输中", at: new Date().toISOString() },
    3
  );
  assert.equal(fuelView(stale.state, "92号汽油").inTransit, 10);
  assert.equal(fuelView(stale.state, "92号汽油").reserved, 0);
});

test("WAL 两阶段：崩在任意一步，重启恢复后单据与台账一致，不多不少", () => {
  for (const crashAt of [1, 2]) {
    const kv = new MemoryKV();
    const first = new LedgerStorage(kv);
    kv.crashAfterSets = crashAt; // 1=崩在WAL后, 2=崩在快照后
    const o = order({ fuel: "柴油", tons: 40 });
    assert.throws(
      () => first.commit({ type: "reserve", order: o }, 1),
      /CRASH/
    );

    // “页面重开”：新进程不再注入崩溃
    kv.crashAfterSets = Infinity;
    const recoveredState = bootstrap(kv);
    assert.equal(recoveredState.version, 2);
    assert.equal(recoveredState.orders.length, 1, `crashAt=${crashAt} 单据恰好一张`);
    assert.equal(fuelView(recoveredState, "柴油").occupied, 40);
    assert.equal(kv.getItem(WAL_KEY), null, "残留 WAL 被清理");

    // 恢复后可以继续正常提交，版本连续
    const recovered = new LedgerStorage(kv);
    recovered.commit(
      { type: "advance", id: o.id, to: "已撤单", at: new Date().toISOString() },
      2
    );
    assert.equal(fuelView(recovered.state, "柴油").occupied, 0);
  }
});

test("WAL 已提交而快照落后时重放，绝不重复落账", () => {
  const kv = new MemoryKV();
  const o = order({ fuel: "95号汽油", tons: 25 });
  const first = new LedgerStorage(kv);
  // 手工制造“快照=v1，WAL=待提交”的半完成现场
  first.commit({ type: "reserve", order: o }, 1);
  const wal = kv.getItem(WAL_KEY);
  // 正常提交后 WAL 已删；构造一个 baseVersion=当前版本-1 的陈旧 WAL
  assert.equal(wal, null);
  const stateV2 = JSON.parse(kv.getItem(STATE_KEY) as string) as LedgerState;
  // 回退快照到 v1，保留同一条事务的 WAL
  const kv2 = new MemoryKV();
  const fresh = new LedgerStorage(kv2);
  fresh.commit({ type: "reserve", order: o }, 1);
  const walEnvelope = {
    baseVersion: 1,
    txn: { type: "reserve" as const, order: o },
    nonce: "x",
    createdAt: new Date().toISOString()
  };
  // 快照清回 v1 空账，仅留 WAL -> 恢复应恰好补成一张单
  kv2.load({ [WAL_KEY]: JSON.stringify(walEnvelope) });
  const recovered = bootstrap(kv2);
  assert.equal(recovered.orders.length, 1);
  assert.equal(recovered.version, 2);
  // 再次 bootstrap 无 WAL 时稳定不动
  const again = bootstrap(kv2);
  assert.equal(again.orders.length, 1);
  void stateV2;
});

const LEGACY_PAYLOAD = JSON.stringify([
  { id: "L1", station: "城东站", fuel: "92号汽油", tons: 18, arriveAt: "2026-07-01", status: "运输中", notes: "车辆已出库", createdAt: "2026-09-20T00:00:00.000Z" },
  { id: "L2", station: "机场站", fuel: "柴油", tons: 12, arriveAt: "2026-07-02", status: "待发车", notes: "等待装车", createdAt: "2026-09-21T00:00:00.000Z" },
  { id: "L3", station: "新区站", fuel: "地沟油", tons: 5, arriveAt: "2026-07-03", status: "待发车", notes: "脏油品", createdAt: "2026-09-22T00:00:00.000Z" },
  { id: "L4", station: "机场站", fuel: "95号汽油", tons: 7, arriveAt: "2026-07-04", status: "已到站", notes: "已收", createdAt: "2026-09-23T00:00:00.000Z" }
]);

async function snapshot(kv: KV): Promise<LedgerState> {
  const storage = new LedgerStorage(kv);
  return storage.snapshot();
}

test("旧版数据一次性迁入：状态映射正确、脏数据跳过不扣减、旧键改名归档", async () => {
  const kv = new MemoryKV();
  kv.setItem(LEGACY_KEY, LEGACY_PAYLOAD);
  const storage = new LedgerStorage(kv);

  const result = await runMigration(storage, kv, undefined, 0);
  assert.equal(result.migrated, 3);
  assert.equal(result.skipped.length, 1);

  const state = storage.snapshot();
  assert.equal(state.migration.phase, "done");
  assert.equal(state.orders.length, 3);
  assert.equal(fuelView(state, "92号汽油").inTransit, 18);
  assert.equal(fuelView(state, "柴油").reserved, 12);
  assert.equal(fuelView(state, "95号汽油").delivered, 7);
  // 检查点 4 项（3 单据 + 1 跳过），再次运行不会重复
  assert.equal(state.migration.migratedIds.length, 4);

  assert.equal(kv.getItem(LEGACY_KEY), null, "旧键已移除");
  assert.ok(kv.getItem(LEGACY_ARCHIVE_KEY)?.includes("L1"), "旧数据改名归档留存");

  // 再跑一次：无新增、无重复扣减
  const again = await runMigration(storage, kv, undefined, 0);
  assert.equal(again.migrated, 0);
  assert.equal(storage.snapshot().orders.length, 3);
});

test("迁移中断后重开只继续未完成项，已落账部分绝不重复扣减", async () => {
  const kv = new MemoryKV();
  kv.setItem(LEGACY_KEY, LEGACY_PAYLOAD);

  // 第一次迁移：只允许 begin + 1 张单据落账后“崩溃”
  kv.crashAfterSets = 4; // WAL/快照/WAL清理 = 每事务2次写；begin(2)+第1单(2)=4
  const s1 = new LedgerStorage(kv);
  await assert.rejects(() => runMigration(s1, kv, undefined, 0), /CRASH/);

  // 页面重开：不再注入崩溃，先做 WAL 恢复再续传
  kv.crashAfterSets = Infinity;
  const partial = bootstrap(kv);
  assert.equal(partial.migration.phase, "migrating");
  assert.equal(partial.migration.migratedIds.length, 1);
  const occupiedBefore = fuelView(partial, "92号汽油").occupied;
  assert.equal(occupiedBefore, 18);
  assert.ok(kv.getItem(LEGACY_KEY), "未迁完旧键必须保留");

  // 重开续传
  kv.crashAfterSets = Infinity;
  const s2 = new LedgerStorage(kv, bootstrap(kv));
  const result = await runMigration(s2, kv, undefined, 0);
  assert.equal(result.resumed, true);
  assert.equal(result.migrated, 2, "只补剩余两张有效单");
  const done = s2.snapshot();
  assert.equal(done.orders.length, 3);
  assert.equal(done.migration.migratedIds.length, 4);
  // 已落账的第一张单占用仍是 18，没有被扣两次
  assert.equal(fuelView(done, "92号汽油").inTransit, 18);
  assert.equal(fuelView(done, "柴油").reserved, 12);
});

test("两窗口并发迁移同一源：后提交者靠冲突重试跳过，占用只扣一次", async () => {
  // 共享底层存储的两个 storage 实例
  const shared = new Map<string, string>();
  const makeKv = (): KV => ({
    getItem: (k) => (shared.has(k) ? shared.get(k)! : null),
    setItem: (k, v) => void shared.set(k, v),
    removeItem: (k) => void shared.delete(k)
  });
  makeKv().setItem(LEGACY_KEY, LEGACY_PAYLOAD);

  const sA = new LedgerStorage(makeKv());
  const sB = new LedgerStorage(makeKv());

  const [rA, rB] = await Promise.all([
    runMigration(sA, makeKv(), undefined, 5),
    runMigration(sB, makeKv(), undefined, 5)
  ]);
  assert.ok(rA.migrated + rB.migrated === 3, `有效单迁入恰好 3 张，实际 ${rA.migrated + rB.migrated}`);
  const final = sA.refresh();
  assert.equal(final.orders.length, 3);
  assert.equal(fuelView(final, "92号汽油").inTransit, 18, "没有重复扣减");
  assert.equal(fuelView(final, "柴油").reserved, 12);
});

test("状态机：迁移单确定性 id 冲突时拒绝，杜绝同一旧单重复落账", () => {
  let state = createInitialState();
  const stamp = new Date().toISOString();
  const migOrder: NewOrder = {
    id: "mig-abc-0000",
    station: "城东站",
    fuel: "92号汽油",
    tons: 10,
    arriveAt: "",
    notes: "迁入",
    status: "待装车",
    createdAt: stamp,
    updatedAt: stamp,
    migrated: true
  };
  state = applyTxn(state, {
    type: "beginMigration",
    sourceHash: "abc",
    total: 1,
    at: stamp
  });
  state = applyTxn(state, { type: "migrateOrder", order: migOrder });
  assert.equal(fuelView(state, "92号汽油").reserved, 10);
  assert.throws(() => applyTxn(state, { type: "migrateOrder", order: migOrder }), RuleError);
});

test("storage 层快照损坏时回退初始台账，不拖垮调度台", () => {
  const kv = new MemoryKV();
  kv.setItem(STATE_KEY, "{不是JSON");
  const state = bootstrap(kv);
  assert.equal(state.version, 1);
  assert.equal(state.orders.length, 0);
});

test("无旧键时种子数据也只迁一次", async () => {
  const kv = new MemoryKV();
  const s1 = new LedgerStorage(kv);
  const r1 = await runMigration(s1, kv, undefined, 0);
  assert.equal(r1.migrated, 2);
  const r2 = await runMigration(new LedgerStorage(kv), kv, undefined, 0);
  assert.equal(r2.migrated, 0);
  const s = await snapshot(kv);
  assert.equal(s.migration.phase, "done");
});
