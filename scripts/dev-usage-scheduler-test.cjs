// Task 9 项 1 闸：usage-scheduler 的 stop() 必须作废「已经 await 出去、正挂着的那一拍」。
// 一期评审判为二期处理：stop() 只清 timer，双命中拍的前半程（本地统计入库）挂起时停机，
// 后半程（WebDAV 上传）照样落地。断言形状照抄一期 dev-watch-test.cjs 断言 6/7：
// 同步跑进 tick → 在第一个 await 处挂住 → stop() → 放行 → 断言后半程不落地；
// 再补断言 7 的同款反证：start() 清掉停机标志，恢复后照常动作。
// 全程打桩（sync / db / sync-config），不碰真实配置目录与数据库。
"use strict";
const assert = require("node:assert");
const Module = require("node:module");
const path = require("node:path");

const BACKEND = path.join(__dirname, "..", "electron", "backend");

function stub(name, exports) {
  const file = path.join(BACKEND, name);
  const m = new Module(file);
  m.filename = file;
  m.loaded = true;
  m.exports = exports;
  require.cache[file] = m;
}

// 控制点：runLocal 返回 pending promise、由测试放行（对应 watch 测试里挂在 fingerprint 的 await）；
// runRemote 只计数——它就是「stop() 之后不该落地」的那一下。
let releaseLocal = null;
let localRuns = 0;
let remoteRuns = 0;
stub("sync.cjs", {
  isBusy: () => false,
  runLocal: () => new Promise((r) => { localRuns++; releaseLocal = r; }),
  runRemote: () => { remoteRuns++; return Promise.resolve(); },
});
stub("db.cjs", { setMeta: () => {}, getMeta: () => undefined });
// 配置：hourly + WebDAV 都配齐，让每一拍 local/remote 双命中（与缺陷场景同形）
stub("sync-config.cjs", {
  loadConfig: () => ({
    schedule: { hourly: true, daily: false, dailyTime: "", hourlyInterval: 1 },
    webdav: { endpoint: "http://stub" },
  }),
});

const scheduler = require(path.join(BACKEND, "usage-scheduler.cjs"));

// 假时钟：调度器的记账（lastLocalAt/lastRemoteAt）会让紧挨着的两拍不重复命中，
// 断言 7 要再触发一拍就得把时钟拨过间隔（2h > hourlyInterval 1h + 本地 30min）。
const realNow = Date.now;
let fakeNow = 1_700_000_000_000;
Date.now = () => fakeNow;

// tick 的后半程是 fire-and-forget 的 async 块，放行后得等事件循环把它跑完
const settle = () => new Promise((r) => setImmediate(r));

(async () => {
  try {
    // 6) stop() 必须作废挂起中的那一拍（形状照抄 dev-watch-test.cjs 断言 6）
    scheduler.tick(); // 同步跑进后半程，挂在 runLocal 的 await 上
    assert.strictEqual(localRuns, 1, "本拍应已开跑本地统计");
    scheduler.stop(); // 就在它挂着的时候停机
    releaseLocal();
    await settle();
    assert.strictEqual(
      remoteRuns,
      0,
      "stop() 后挂起中的那一拍必须作废，实到 " + remoteRuns + " 次远程上传"
    );

    // 7) start() 要清掉停机标志，恢复后照常双命中（反证作废闸没有把重启后的调度焊死）
    fakeNow += 2 * 60 * 60 * 1000; // 拨过间隔，让 local/remote 重新双命中
    scheduler.start();
    scheduler.tick();
    assert.strictEqual(localRuns, 2, "start() 后新拍应照常开跑本地统计");
    releaseLocal(); // 这拍没有停机，放行后远程照常
    await settle();
    assert.strictEqual(remoteRuns, 1, "start() 后未停机的一拍应照常远程上传");
    scheduler.stop(); // 别把 60s 的 timer 留在事件循环里

    console.log("OK usage-scheduler stop() 在飞作废断言全通过");
  } finally {
    Date.now = realNow;
  }
})().catch((e) => { console.error(e); process.exit(1); });
