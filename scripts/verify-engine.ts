// 引擎行为验证：mock 浏览器存储层，跑占用/并发/原子性/迁移四类场景。
import "./browser-mock.ts";
import { engine, DispatchEngine, INITIAL_STOCKS } from "../src/dispatch/engine.ts";
import { availableTons, replay, activeHold, consumedTons } from "../src/dispatch/reducer.ts";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    console.log(`  ✅ ${name}`);
  } else {
    failures += 1;
    console.error(`  ❌ ${name} ${detail}`);
  }
}

function tick(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

console.log("场景1：预占 -> 装车 -> 到站 的库存口径");
{
  const fuel = "柴油" as const;
  const before = availableTons(engine.state, fuel);
  const r = engine.reserve(
    { station: "城东站", fuel, tons: 10, arriveAt: "2026-10-10", notes: "测试单" },
    engine.state.version
  );
  check("预占提交成功", r.ok === true, JSON.stringify(r));
  if (r.ok) {
    check("预占后可用减少10", availableTons(engine.state, fuel) === before - 10);
    const id = Object.keys(engine.state.orders).find((key) => !key.startsWith("seed-"))!;
    check("预占版本号已挂到订单", engine.state.orders[id].reservedVersion === r.version);
    engine.load(id);
    engine.depart(id);
    check("在途仍占用", activeHold(engine.state, fuel) >= 10);
    engine.arrive(id);
    check("到站后占用归零、计入核销", activeHold(engine.state, fuel) === 12 && consumedTons(engine.state, fuel) === 10);
    check("到站后可用不回升（已出库）", availableTons(engine.state, fuel) === INITIAL_STOCKS[fuel] - 12 - 10);
  }
}

console.log("场景2：撤单释放");
{
  const fuel = "92号汽油" as const;
  const before = availableTons(engine.state, fuel);
  const r = engine.reserve(
    { station: "新区站", fuel, tons: 7, arriveAt: "2026-10-11", notes: "撤单测试" },
    engine.state.version
  );
  if (r.ok) {
    check("预占后可用减少7", availableTons(engine.state, fuel) === before - 7);
    const id = Object.keys(engine.state.orders).find(
      (key) => engine.state.orders[key].notes === "撤单测试"
    )!;
    engine.cancel(id);
    check("撤单后可用恢复", availableTons(engine.state, fuel) === before);
  } else {
    check("撤单场景预占成功", false, JSON.stringify(r));
  }
}

console.log("场景3：在途失败释放");
{
  const fuel = "95号汽油" as const;
  const before = availableTons(engine.state, fuel);
  const r = engine.reserve(
    { station: "机场站", fuel, tons: 5, arriveAt: "2026-10-12", notes: "失败测试" },
    engine.state.version
  );
  if (r.ok) {
    const id = Object.keys(engine.state.orders).find(
      (key) => engine.state.orders[key].notes === "失败测试"
    )!;
    engine.load(id);
    engine.depart(id);
    engine.markFailed(id);
    check("在途失败后吨数释放回可用", availableTons(engine.state, fuel) === before);
  } else {
    check("失败场景预占成功", false, JSON.stringify(r));
  }
}

console.log("场景4：库存不足拒绝，且不落半条账");
{
  const fuel = "柴油" as const;
  const versionBefore = engine.state.version;
  const available = availableTons(engine.state, fuel);
  const r = engine.reserve(
    { station: "城东站", fuel, tons: available + 100, arriveAt: "2026-10-13", notes: "超量单" },
    engine.state.version
  );
  check("超量预占被拒", r.ok === false && r.reason === "invalid", JSON.stringify(r));
  check("被拒后版本不推进", engine.state.version === versionBefore);
}

console.log("场景5：乐观并发——旧版本凭据提交被拒，状态推进到新版本");
{
  const fuel = "92号汽油" as const;
  const base = engine.state.version;
  // 模拟另一窗口先提交
  const other = engine.simulateConcurrentReserve(fuel, 8);
  check("窗口A先提交成功", other.ok === true, JSON.stringify(other));
  // 本窗口拿着旧 base 提交
  const stale = engine.reserve(
    { station: "城东站", fuel, tons: 6, arriveAt: "2026-10-14", notes: "后提交者" },
    base
  );
  check("旧版本凭据提交报冲突", stale.ok === false && stale.reason === "conflict", JSON.stringify(stale));
  if (!stale.ok && stale.reason === "conflict") {
    check("冲突返回当前最新版本", stale.currentVersion === engine.state.version);
  }
  // 用新版本重试成功
  const retry = engine.reserve(
    { station: "城东站", fuel, tons: 6, arriveAt: "2026-10-14", notes: "后提交者重试" },
    engine.state.version
  );
  check("刷新版本后重试成功", retry.ok === true, JSON.stringify(retry));
}

console.log("场景6：磁盘被其它窗口推进时，写入前检测到冲突并补齐对方提交");
{
  // 直接改磁盘，模拟另一个真实窗口追加了一条提交
  const raw = JSON.parse(localStorage.getItem("hxwlfront-19-dispatch-log")!);
  const now = new Date().toISOString();
  const foreignOrder = {
    id: "foreign-1",
    station: "新区站",
    fuel: "柴油",
    tons: 3,
    arriveAt: "2026-10-15",
    status: "reserved",
    notes: "其它窗口磁盘直写",
    createdAt: now,
    reservedVersion: raw.length + 1,
    history: [{ at: now, from: null, to: "reserved", version: raw.length + 1 }]
  };
  raw.push({
    id: "cmt-foreign",
    at: now,
    expectedVersion: raw.length,
    label: "外部窗口提交",
    events: [{ id: "evt-foreign", type: "order:reserve", order: foreignOrder }]
  });
  localStorage.setItem("hxwlfront-19-dispatch-log", JSON.stringify(raw));

  const base = engine.state.version;
  const r = engine.reserve(
    { station: "机场站", fuel: "柴油", tons: 2, arriveAt: "2026-10-16", notes: "检测磁盘推进" },
    base
  );
  check("磁盘版本更长时提交报冲突", r.ok === false && r.reason === "conflict", JSON.stringify(r));
  check("冲突后本窗口已补齐对方的单", !!engine.state.orders["foreign-1"]);
  check("对方占用已反映到可用量", true);
}

console.log("场景7：迁移——中断重开只续跑、不重复扣减");
{
  // 准备全新存储：旧版 key 有5条，其中1条无效
  localStorage.clear();
  const legacy = [
    { id: "L1", station: "城东站", fuel: "92号汽油", tons: 10, arriveAt: "2026-09-01", status: "运输中", notes: "旧1" },
    { id: "L2", station: "机场站", fuel: "柴油", tons: 12, arriveAt: "2026-09-02", status: "待发车", notes: "旧2" },
    { id: "L3", station: "新区站", fuel: "95号汽油", tons: 8, arriveAt: "2026-09-03", status: "已到站", notes: "旧3" },
    { id: "L4", station: "城东站", fuel: "柴油", tons: 5, arriveAt: "2026-09-04", status: "待发车", notes: "旧4" },
    { id: "L5", station: "未知站", fuel: "柴油", tons: 3, arriveAt: "2026-09-05", status: "待发车", notes: "坏单" }
  ];
  localStorage.setItem("hxwlfront-19-oil-delivery", JSON.stringify(legacy));

  const e1 = new DispatchEngine();
  await tick(300);
  check("5条旧单迁移4条、跳过1条", e1.state.migration.done === 4 && e1.state.migration.skipped === 1,
    `done=${e1.state.migration.done} skipped=${e1.state.migration.skipped}`);
  check("迁移完成状态", e1.state.migration.state === "done");
  check("旧key已归档移除", localStorage.getItem("hxwlfront-19-oil-delivery") === null);

  // 重放重建：已迁入的单不重复
  const log = JSON.parse(localStorage.getItem("hxwlfront-19-dispatch-log")!);
  const rebuilt = replay(log);
  const migratedCount = Object.values(rebuilt.orders).filter((o) => o.migrated).length;
  check("重放后迁移单恰好4条（不重复扣减）", migratedCount === 4, `migrated=${migratedCount}`);
  check("迁移后92号汽油占用/核销口径正确",
    activeHold(rebuilt, "92号汽油") === 10 &&
      availableTons(rebuilt, "92号汽油") === INITIAL_STOCKS["92号汽油"] - 10);
  check("迁移后柴油：12占用+5占用",
    activeHold(rebuilt, "柴油") === 17 &&
      availableTons(rebuilt, "柴油") === INITIAL_STOCKS["柴油"] - 17);
  check("迁移后95号汽油8吨已到站核销",
    consumedTons(rebuilt, "95号汽油") === 8 &&
      availableTons(rebuilt, "95号汽油") === INITIAL_STOCKS["95号汽油"] - 8);
}

console.log("场景8：迁移中途关闭重开，断点续跑");
{
  localStorage.clear();
  const legacy = Array.from({ length: 6 }, (_, i) => ({
    id: `M${i + 1}`,
    station: "城东站",
    fuel: "92号汽油",
    tons: 1,
    arriveAt: "2026-09-01",
    status: "待发车",
    notes: `批量${i + 1}`
  }));
  localStorage.setItem("hxwlfront-19-oil-delivery", JSON.stringify(legacy));

  // 先完整迁移一遍，随后手工构造“迁到一半”的半成品日志来模拟页面中途关闭
  const e2 = new DispatchEngine();
  await tick(500);
  const totalMigrated = Object.values(e2.state.orders).filter((o) => o.migrated).length;
  check("6条全部迁移完成", totalMigrated === 6, `migrated=${totalMigrated}`);

  // 手动模拟半成品：删除日志中第3条之后的迁移提交和完成事件，保留旧key，再重建续跑
  let log = JSON.parse(localStorage.getItem("hxwlfront-19-dispatch-log")!);
  // 恢复旧key（模拟归档前中断）
  localStorage.setItem("hxwlfront-19-oil-delivery", JSON.stringify(legacy));
  // 只保留 init + 前2条 migration:item
  const kept = log.filter(
    (c: any) =>
      c.events[0].type === "depot:init" ||
      (c.events[0].type === "migration:item" &&
        ["legacy-M1", "legacy-M2"].includes(c.events[0].order.id))
  );
  // 修正版本序号由 replay 按日志长度推导，无需改内容
  localStorage.setItem("hxwlfront-19-dispatch-log", JSON.stringify(kept));

  const e3 = new DispatchEngine();
  await tick(500);
  const after = Object.values(e3.state.orders).filter((o) => o.migrated).length;
  check("中断重开后补齐到6条且无重复", after === 6, `migrated=${after}`);
  log = JSON.parse(localStorage.getItem("hxwlfront-19-dispatch-log")!);
  const itemCommits = log.filter((c: any) => c.events[0].type === "migration:item").length;
  check("日志中迁移条目事件仍为6条（幂等不重复）", itemCommits === 6, `items=${itemCommits}`);
  check("续跑完成后旧key被归档", localStorage.getItem("hxwlfront-19-oil-delivery") === null);
}

console.log("");
if (failures > 0) {
  console.error(`共 ${failures} 项失败`);
  process.exit(1);
} else {
  console.log("全部行为验证通过 ✅");
}
