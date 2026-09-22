// 网关命令管道的**最小可用版**（二期 Task 3）：serve / connect / call / broadcast 四件套齐全，
// 够把「子进程这个存在」立起来——spawn 后主进程能连上、能验 token、能回传事件。
//
// 刻意不含的东西都归 Task 4 硬化，别在这里顺手做掉：
//  · 响应配对乱序的正确性论证与 pending 上界（MAX_PENDING 常量已在 proto 里，本文件不 enforce）
//  · 默认 10 s 超时（这里只在调用方显式传 opts.timeoutMs 时才计时；默认**永不超时**）
//  · 「带写副作用的命令不重放」（今天压根没有重放逻辑，等有了再守）
//  · 溢出断开的策略细化（createParser 的 onOverflow 这里只关连接）
//
// 传输：Windows named pipe，走 net.createServer / net.connect 的 pipe path 形态（`\\.\pipe\…`）。
// 不开第二个 TCP 端口（规格 §5.2）：不占端口、无防火墙面、随进程消失。
"use strict";
const net = require("node:net");
const proto = require("./gateway-proto.cjs");
const log = require("./gateway-log.cjs");

let SEQ = 0;
const nextId = () => String(++SEQ);

/** 一行帧写出去；连接已不可写就 silently drop（事件帧丢了就丢了，命令帧由 pending 超时兜）。 */
function writeFrame(sock, frame) {
  try {
    if (sock && sock.writable) sock.write(proto.encode(frame));
  } catch { /* 对端已断 */ }
}

/**
 * 子进程侧：建管道、验 token、把 req 分派给 dispatch。
 * dispatch(cmd, args) → 任意值 / Promise；抛错回 { ok:false, message }。
 * 返回 Promise<srv>：listen 失败（同名管道已存在 / 权限）时 reject。
 */
function serve({ token, pipePath, dispatch } = {}) {
  if (!pipePath) return Promise.reject(new Error("serve 需要 pipePath（由主进程命名并经握手投递）"));
  if (!token) return Promise.reject(new Error("serve 需要 token（管道是唯一入口，无 token 即裸奔）"));
  const clients = new Set();          // 只装**已通过 token 校验**的连接：事件只发给它们
  let resolveReady;
  const ready = new Promise((r) => { resolveReady = r; });
  let firstClient = true;

  const server = net.createServer((sock) => {
    let authed = false;
    sock.setEncoding("utf8");
    const onFrame = (f) => {
      if (!f || typeof f !== "object") return;
      if (f.k === "hello") {
        if (String(f.token || "") !== String(token)) {
          // token 不匹配 = 拿陈旧 gateway.json 来连的人（pid 复用 / 上一版残留）。
          // 认领双检的第二检就落在这里：主进程 probeAlive 会因此拿不到响应 → 判 false。
          log.line("pipe-reject", { why: "token-mismatch", cmd: String(f.cmd || "") });
          try { sock.destroy(); } catch { /* 已断 */ }
          return;
        }
        authed = true;
        clients.add(sock);
        if (firstClient) { firstClient = false; resolveReady(); }
        return;
      }
      if (!authed) { try { sock.destroy(); } catch { /* 已断 */ } return; }
      if (f.k !== "req") return;      // 本期渲染层不向子进程发其它帧类型
      const id = String(f.id);
      Promise.resolve()
        .then(() => dispatch(String(f.cmd), f.args))
        .then((data) => writeFrame(sock, { k: "res", id, ok: true, data }))
        .catch((e) => writeFrame(sock, { k: "res", id, ok: false, message: String((e && e.message) || e) }));
    };
    const feed = proto.createParser(onFrame, () => {
      log.line("pipe-overflow", { maxBytes: proto.MAX_FRAME_BYTES });
      try { sock.destroy(); } catch { /* 已断 */ }
    });
    sock.on("data", feed);
    sock.on("error", () => { try { sock.destroy(); } catch { /* 已断 */ } });
    sock.on("close", () => clients.delete(sock));
  });

  return new Promise((resolve, reject) => {
    let listening = false;
    server.on("error", (e) => {
      // listen 之前的错误 = 起不来，必须 reject 给入口；之后的错误（管道被强拆等）只留痕，
      // 不能让一个已建好的管道把进程搞崩。
      if (!listening) { reject(e); return; }
      log.line("pipe-server-error", { message: String((e && e.message) || e) });
    });
    server.listen(pipePath, () => {
      listening = true;
      resolve({
        pipePath,
        /** 主进程连上第一帧并通过 token 校验后才算 ready（gateway.cjs 在写 gateway.json 之后 await 它） */
        ready,
        broadcast: (frame) => { for (const c of clients) writeFrame(c, frame); },
        close: () => {
          for (const c of clients) { try { c.destroy(); } catch { /* 已断 */ } }
          clients.clear();
          try { server.close(); } catch { /* 已关 */ }
          try { server.unref(); } catch { /* 已关 */ }
        },
      });
    });
  });
}

/**
 * 主进程侧：连管道并投 hello。
 *
 * timeoutMs 的语义是「**在这个时限内反复重试到管道出现**」，不是「一次 connect 的 socket 超时」。
 * 这是实测逼出来的：具名管道还没被 listen 时 net.connect 是**立刻**回 ENOENT 的，
 * 单次 socket 超时会把 start() 的 8 s 与 probeAlive 的 1.5 s 在第一毫秒就判成死（子进程还没起来就被认成没起）。
 * 建上之后不再有空闲超时——空闲长连接是设计常态，per-call 默认超时归 Task 4。
 */
function connect({ pipePath, token, timeoutMs } = {}) {
  if (!pipePath) return Promise.reject(new Error("connect 需要 pipePath"));
  const RETRY_MS = 80;
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + (Number(timeoutMs) > 0 ? Number(timeoutMs) : 0);
    let settled = false;
    const attempt = () => {
      if (settled) return;
      const sock = net.connect(pipePath);
      const pending = new Map();
      const eventCbs = new Set();
      let dead = false;
      let done = false;                 // 这条连接自身的建连结果已定（之后只走 drop 路径）
      let gaveUp = false;               // 这一次尝试已经判定失败（error 与 close 会一起到，只算一次）
      let gaveUpTimer = null;

      const onConnect = () => {
        if (settled || done) return;
        done = true;
        settled = true;
        sock.setTimeout(0);             // 建连后清掉连接阶段的超时，不留空闲计时器
        writeFrame(sock, { k: "hello", token: String(token || "") });
        resolve(conn);
      };
      const failAttempt = (e) => {
        if (settled || done || gaveUp) return;
        gaveUp = true;
        try { sock.destroy(); } catch { /* 已断 */ }
        if (Date.now() < deadline) {
          // 这条重试计时器**绝对不许 unref**：管道不存在时 connect 是瞬时失败的，
          // 一旦 unref，事件循环里再没有别的 ref 句柄 → node 直接以退出码 0 静默收摊，
          // 上层 await 永远不返回（实测：把 gateway.cjs 挪走之后本闸无输出、退出 0）。
          gaveUpTimer = setTimeout(attempt, RETRY_MS);
          return;
        }
        settled = true;
        reject(e);
      };

      sock.on("connect", onConnect);
      sock.on("error", (e) => { if (!done) failAttempt(e); else drop(e); });
      sock.on("close", () => { if (!done) failAttempt(new Error("管道不存在或已关闭：" + pipePath)); else drop(new Error("管道已关闭")); });

      const onFrame = (f) => {
        if (!f || typeof f !== "object") return;
        if (f.k === "res") {
          const p = pending.get(String(f.id));
          if (!p) return;               // 迟到的响应（已被超时判死）：丢弃，不重发
          pending.delete(String(f.id));
          if (p.timer) clearTimeout(p.timer);
          if (f.ok) p.resolve(f.data);
          else p.reject(new Error(String(f.message || "子进程返回失败")));
          return;
        }
        if (f.k === "evt") {
          for (const cb of eventCbs) { try { cb(f.payload); } catch { /* 订阅者的错不带崩管道 */ } }
        }
      };
      const feed = proto.createParser(onFrame, () => {
        log.line("pipe-client-overflow", { maxBytes: proto.MAX_FRAME_BYTES });
        drop(new Error("管道帧超过上限，断开"));
      });
      sock.on("data", feed);

      function drop(e) {
        if (dead) return;
        dead = true;
        for (const p of pending.values()) {
          if (p.timer) clearTimeout(p.timer);
          p.reject(e);                  // token 被拒 = 服务端直接 destroy，这里的 reject 就是认领双检的判据
        }
        pending.clear();
        try { sock.destroy(); } catch { /* 已断 */ }
      }

      const conn = {
        pipePath,
        get connected() { return !dead && sock.writable; },
        /** 只给**已建连**的连接用：opts.timeoutMs 显式传才计时（默认永不超时，见文件头） */
        call: (cmd, args, opts) => new Promise((resolve2, reject2) => {
          if (dead) { reject2(new Error("管道已断开，命令未投递：" + cmd)); return; }
          const id = nextId();
          const rec = { resolve: resolve2, reject: reject2, timer: null };
          const ms = opts && Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 0;
          if (ms) rec.timer = setTimeout(() => {
            if (!pending.has(id)) return;
            pending.delete(id);
            reject2(new Error("子进程未在 " + ms + "ms 内应答：" + cmd));
          }, ms);
          pending.set(id, rec);
          writeFrame(sock, { k: "req", id, cmd: String(cmd), args: args || {} });
        }),
        onEvent: (cb) => { eventCbs.add(cb); return () => eventCbs.delete(cb); },
        unref: () => { try { sock.unref(); } catch { /* 已断 */ } },
        close: () => { drop(new Error("管道已主动关闭")); },
      };
    };
    attempt();
  });
}

module.exports = { serve, connect };
