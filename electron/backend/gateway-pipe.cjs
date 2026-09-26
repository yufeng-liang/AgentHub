// 网关命令管道（二期 Task 3 立起最小版，Task 4 硬化到位）：serve / connect / call / broadcast 四件套。
//
// 每条判据都有闸项（scripts/dev-gateway-pipe-test.cjs 的 ⑨ 组），改之前先看它们红什么：
//  · 配对：响应按帧里的 id 认领 pending，**不**按到达顺序、不按 FIFO。派发顺序 = 帧到达顺序，
//    完成顺序可以任意乱（⑨a 用真命令表、⑨a-2 用人为反序的 hold 梯度各钉一半）。
//  · 默认超时：除 proto.NO_TIMEOUT_CMDS 那三条之外，每条 call 都有 proto.DEFAULT_TIMEOUT_MS 的上界。
//    这既兜「子进程里那条命令挂死」，也兜「响应帧压根没写出去」（见 writeFrame 的返回值）。
//    没有这条上界时，「主进程发出去的命令永远不回来」是静默的——Task 3 的注释就是这么承诺的。
//  · 有界队列：单条连接在途（pending）不超过 proto.MAX_PENDING，超出**立即**拒，不排队也不等超时。
//    上界刻意落在**客户端**：pending 这本账本来就记在连接上，而生产里唯一的客户端就是主进程，
//    于是子进程同刻要处理的命令数被同一个数钉住（闸 ⑨d 两头都量：客户端拒了多少 + 服务端峰值在飞多少）。
//    被拒的命令一条都没投出去，所以「重复执行写操作」的风险为零，语义与重放不同。
//    另有服务端**跨连接**总账 proto.MAX_TOTAL_PENDING（Task 5 刀 1，闸 ⑨i）：MAX_PENDING 是每连接的
//    账，k 条认证连接各 64 = k×64，总账与单连接上界同值，多连接不因 k 放大子进程的在飞堆量；
//    被总账拒的命令从未被派发，回普通业务失败（不带 notRetried），重试语义交给调用方。
//  · 不重放：本期**不实现任何自动重试**。实测依据（不是推测）：pool.cjs 的 poolAccounts() 会把
//    「派生复活」经 store.updateAccount() 回写、effectiveStatus() 在 cooling/exhausted 到期时真落库，
//    所以 proto.NON_IDEMPOTENT_READS 里那两条「读」都带写副作用；二期没有幂等表，重放一次就是重复执行一次写。
//    所有失败路径（断连 / 超时 / 未投递 / 队列满）回的 Error 都带 notRetried 标记，闸 ⑨e 数服务端调用次数钉死它。
//  · 溢出即判死：单帧超过 proto.MAX_FRAME_BYTES 时**断开这条连接**并记日志，绝不截断后继续解析
//    （截断继续用 = 把一条被腰斩的帧当成合法命令）。两端各一份，闸 ⑨f 两头都灌一次真超限数据。
//  · 两条队列都有界：命令帧在单连接上被客户端的 MAX_PENDING 钉住（超界立即拒）；事件帧没有 id 也没有
//    ack、生产者却是周期性的（credits 调度、poolsync 进度、请求完成），所以 broadcast 在**写之前**看这条
//    连接发送队列的 writableLength——已越过 highWaterMark 就丢该帧并记 event-frame-dropped，绝不在子进程里
//    另排一条无界队列（规格 §5.2）。丢帧不判死连接：事件是尽力投递，命令帧走另一条路且各自有 id 与上界。
//    **关键事件不在丢的行列**（Task 5 刀 1，闸 ⑨g）：proto.CRITICAL_EVENTS（oauth-done / oauth-open，
//    它们是 oauthWaiting 一类 UI 等待态的唯一出口）绕过丢弃判据照写——丢一帧就是用户可见的永久卡死，
//    而 oauth 事件是用户驱动的，量级差几个数量级，无界风险可忽略。
//  · 写帧四态（Task 5 刀 1，闸 ⑨c）：writeFrame 回 "written"/"queued"/"unwritable"/"unencodable"，
//    「编帧失败（一字节没入队）」与「背压（帧已入队）」分开善后——req 侧编帧失败立即按未投递改判
//    （命令绝无可能已跑过），res 侧编帧失败补发必可编码的错误响应（命令已真跑完，落在业务失败一类，
//    不许重试也不许让客户端干等默认超时），两条路径都留 pipe-frame-encode-error。
//
// 传输：Windows named pipe，走 net.createServer / net.connect 的 pipe path 形态（`\\.\pipe\…`）。
// 不开第二个 TCP 端口（规格 §5.2）：不占端口、无防火墙面、随进程消失。
"use strict";
const net = require("node:net");
const proto = require("./gateway-proto.cjs");
const log = require("./gateway-log.cjs");

let SEQ = 0;
const nextId = () => String(++SEQ);

/**
 * 把一帧编出来并写出去。返回**四态**之一（Task 5 刀 1 起不再用布尔把「编不了」压进「写不出去」——
 * 那两态一字节都没入队，善后是「立即改判」；而「queued」帧已经进了 socket 的发送队列，只能等回执）：
 *  · "written"     —— 编帧成功且 sock.write() 回 true（未越过 highWaterMark）；
 *  · "queued"      —— 编帧成功、sock.write() 回 false 但 socket 仍可写（**背压**：帧进了这条 socket
 *                     自己的发送队列，没丢！调用方该停手等 'drain'。把它当「写成功」= 以为能无限往下排
 *                    （评审 I2 的成因就是这个返回值被丢掉）；把它当「没写出去」= 误报「未投递」，而命令
 *                     可能已经在子进程里跑完并落了库）；
 *  · "unwritable"  —— socket 不可写 / write() 抛错（对端已断）：帧没进队列；
 *  · "unencodable" —— 载荷连 JSON 都编不了（循环引用 / BigInt 一类编程错）：一字节都没入队，
 *                     调用方必须**立即**按「未投递 / 未回执」改判并留痕，绝不静默——静默丢帧是这里
 *                     最坏的失败形态：调用方拿不到任何信号，命令就只剩「永远不回来」。
 */
function writeFrame(sock, frame) {
  let text;
  try { text = proto.encode(frame); } catch { return "unencodable"; }
  if (!sock || !sock.writable) return "unwritable";
  try { return sock.write(text) ? "written" : "queued"; } catch { return "unwritable"; }
}

/**
 * 「这条命令不会被自动重放」的统一错因（文件头第四条）。
 * 也是**所有**失败路径共用的错误形状：`notRetried` + `command`。管道层四类（断连 / 超时 / 未投递 / 队列满）
 * 之外还有主进程侧那一支「压根没连接」——gateway-client.call() 的早退也走它（闸 ⑨h），因为 Task 5 的
 * 转发体是按这个标记决定「能不能重发」的，形状不统一就会漏一支。
 */
function noRetryError(message, cmd) {
  const idempotencyRisk = proto.NON_IDEMPOTENT_READS.has(String(cmd));
  const e = new Error(message + "（不会自动重放"
    + (idempotencyRisk
      ? "：" + cmd + " 带写副作用（号池派生复活要回写库），重放等于重复执行写操作"
      : "：二期无幂等表，重放的语义风险大于收益")
    + "）");
  e.notRetried = true;
  e.command = String(cmd);
  return e;
}

/**
 * 这条 call 的超时上界（0 = 不设上界）。顺序有意义：
 *  · NO_TIMEOUT_CMDS 那三条的语义本就是「立即返回 + 进度走 evt 帧」（长任务在子进程内部自己收），
 *    管道层不给它们设上界——那是「允许长任务挂着管道」的反面：它们压根不挂；
 *  · 其余一律有默认上界，调用方显式给的 opts.timeoutMs（> 0）优先。
 * 要放宽就传显式值；要免超时只能进那份清单（三个名字由闸 ⑨ 钉着，不许随手加）。
 */
function timeoutFor(cmd, opts) {
  if (proto.NO_TIMEOUT_CMDS.has(String(cmd))) return 0;
  const explicit = Number(opts && opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 0;
  return explicit || proto.DEFAULT_TIMEOUT_MS;
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
  let inFlightTotal = 0;              // 跨连接在飞总账：所有已认证连接上「已派发、未回话」的命令数（⑨i）

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
      const cmd = String(f.cmd);
      const reply = (frame) => {
        // 响应帧与事件帧在这里**相反**：背压时照排不误，只有「真没写出去」才留痕。理由是客户端那条 id 正在
        // 等回执，中途丢弃就是「命令真跑了却没回执」的错判；而它不会堆成无界队列——单连接在飞的命令数被
        // 客户端的 MAX_PENDING 钉住（见文件头第三条），这条连接上最多攒 64 帧响应。
        const wf = writeFrame(sock, frame);
        if (wf === "written" || wf === "queued") return;
        if (wf === "unencodable") {
          // 响应体编不出帧（dispatch 返回了循环引用/BigInt 一类）：命令**已经真跑完**（副作用已发生），
          // 但回执永远出不去。补发一条必可编码的错误响应（message 是纯字符串），让客户端立刻拿到
          // 确定性失败而不是干等默认超时；错误落在「业务失败」一类（不带 notRetried）——调用方不会
          // 重试它，「重放 = 重复执行写」的语义不被破坏。留痕，否则排障时这条路径完全不可见。
          log.line("pipe-frame-encode-error", { k: "res", id, cmd });
          if (writeFrame(sock, { k: "res", id, ok: false, message: "响应帧编码失败（返回值不可 JSON 序列化），命令已执行：" + cmd }) === "unwritable") {
            log.line("pipe-frame-dropped", { k: "res", id, cmd, why: "encode-error-reply", peerWritable: false });
          }
          return;
        }
        // 响应帧没写出去 = 客户端那条 id 只能等它自己的默认超时才有结论。留痕，否则排查时只剩
        // 「主进程说子进程不回话」，而子进程日志里连一次派发记录都没有。
        log.line("pipe-frame-dropped", { k: "res", id, cmd, peerWritable: false });
      };
      // 跨连接在飞总账（Task 5 刀 1 件 5）：MAX_PENDING 是**每连接**的账，k 条认证连接各 64 = k×64，
      // 规格 §5.2 的目的状语「避免主 App 卡死时子进程堆内存」在多连接下就不成立。总账取与单连接上界
      // 同值（proto.MAX_TOTAL_PENDING）：多连接不因 k 放大子进程的在飞堆量。被拒的命令**从未被派发**，
      // 重试语义安全——所以这里回普通业务失败（不带 notRetried），重试与否交给调用方。
      if (inFlightTotal >= proto.MAX_TOTAL_PENDING) {
        log.line("pipe-req-rejected", { why: "global-inflight-cap", cmd, inFlight: inFlightTotal, cap: proto.MAX_TOTAL_PENDING });
        reply({ k: "res", id, ok: false, message: "服务端在飞命令已达全局上界（" + inFlightTotal + " / " + proto.MAX_TOTAL_PENDING + "），命令未受理：" + cmd });
        return;
      }
      inFlightTotal += 1;
      Promise.resolve()
        .then(() => dispatch(cmd, f.args))
        .then(
          (data) => { inFlightTotal -= 1; reply({ k: "res", id, ok: true, data }); },
          (e) => { inFlightTotal -= 1; reply({ k: "res", id, ok: false, message: String((e && e.message) || e) }); }
        );
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
        // 事件帧的队列必须有界（规格 §5.2「队列不得无界……避免主 App 卡死时子进程堆内存」，评审 I2）。
        // 事件帧与命令/响应帧不是一条路：它没有 id、不占客户端的 pending、也没有 ack，生产者却是周期性
        // 的（credits 30 分钟调度、poolsync 进度、请求完成）。主进程卡死而连接还挂着时，这些帧会**全部**
        // 堆在子进程的发送队列里 —— 命令帧不会，它在单条连接上被客户端的 MAX_PENDING 钉住（文件头第三条）。
        // 所以这里给事件帧补第二条界：这条连接的发送队列已经越过 highWaterMark 就当场丢掉该帧并留痕，
        // 绝不另排一条无界队列；也**不因为一帧丢弃把连接判死**（事件是尽力投递，掉一帧下次状态还能对上；
        // 判死会把同一连接上正在跑的命令帧一起打成「未投递」，那才是真的把事办坏）。闸 ⑨g 两头都钉：
        // 灌 50 MB 只让个位数帧入队 + 逐条留痕，且那条连接随后还能收命令帧。
        broadcast: (frame) => {
          const type = String((frame && frame.payload && frame.payload.type) || "");
          const critical = proto.CRITICAL_EVENTS.has(type);
          let text;
          if (critical) {
            // 关键事件（CRITICAL_EVENTS：oauthWaiting 一类 UI 等待态的**唯一**出口）绕过丢弃判据：
            // 丢一帧就是用户可见的永久卡死。无界风险可忽略——oauth 事件是用户驱动的（一次登录流程
            // 至多几帧），量级与周期性事件源（credits 30 分钟调度、poolsync 进度）差几个数量级。
            try { text = proto.encode(frame); } catch {
              log.line("pipe-frame-encode-error", { k: String((frame && frame.k) || ""), type });
              return;                                    // 载荷连 JSON 都不了 = 编程错，整条丢掉但必须留痕
            }
          } else {
            try { text = proto.encode(frame); } catch { return; }   // 普通事件编不了 = 编程错，整条丢掉
          }
          for (const c of clients) {
            if (!c.writable) continue;              // 对端已断：close 马上会把它从 clients 里摘掉，不必留痕
            // 背压的判据必须落在**写之前**：sock.write() 回 false 时那一帧已经在队列里了，拿它当
            // 「丢掉这一帧」是句空话（实测那样写时 200 帧 / 50 MB 仍然全部入队，闸 ⑨g 就是这么红的）。
            // 所以这里看的是「这条连接的发送队列是否已经堆到 highWaterMark」——越线即丢，一帧都不进队列。
            if (!critical && c.writableLength >= (c.writableHighWaterMark || 16384)) {
              log.line("event-frame-dropped", {
                reason: "backpressure", k: String((frame && frame.k) || ""), type,
                bytes: text.length, queued: c.writableLength, peerWritable: true,
              });
              continue;
            }
            try { c.write(text); } catch { /* 对端已断：socket 自己会走 close */ }
          }
        },
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
 * 建上之后不再有空闲超时——空闲长连接是设计常态（管道 ≠ 监听，Task 5 全靠这条），per-call 的超时上界
 * 由 timeoutFor() 给：除 NO_TIMEOUT_CMDS 三条之外一律有 proto.DEFAULT_TIMEOUT_MS 兜底。
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
          if (!p) return;               // 迟到的响应（已被超时或断连判死）：丢弃，绝不重发也不复活
          pending.delete(String(f.id));
          if (p.timer) clearTimeout(p.timer);
          if (f.ok) p.resolve(f.data);
          else p.reject(new Error(String(f.message || "子进程返回失败")));   // 业务失败：命令真跑了，不属于「重放」范畴
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
        // 传输层失败一律带上「不会自动重放」的错因：这些命令可能已经在子进程里跑完了（写副作用已落库），
        // 客户端只是没听到回执——恰恰是最不该被重试的那一类。
        for (const p of pending.values()) {
          if (p.timer) clearTimeout(p.timer);
          p.reject(noRetryError(String((e && e.message) || e), p.cmd));
        }
        pending.clear();
        try { sock.destroy(); } catch { /* 已断 */ }
      }

      const conn = {
        pipePath,
        get connected() { return !dead && sock.writable; },
        /** 投一条命令并等自己的响应帧。四件事按文件头那四条判据逐条落：有上界、有队列、不重放、按 id 配对。 */
        call: (cmd, args, opts) => new Promise((resolve2, reject2) => {
          const id = nextId();
          if (dead) { reject2(noRetryError("管道已断开，命令未投递：" + cmd, cmd)); return; }
          // 有界队列：超出上界**立即**拒（不等默认超时，那会让渲染层白等 10 s）。错误里必须带上当前
          // pending 数与上界，否则排障时「队列已满」和「子进程不回话」分不开。
          if (pending.size >= proto.MAX_PENDING) {
            reject2(noRetryError("命令队列已满（待响应 " + pending.size + " 条 / 上界 " + proto.MAX_PENDING
              + "），命令未投递：" + cmd, cmd));
            return;
          }
          const ms = timeoutFor(cmd, opts);
          const rec = { resolve: resolve2, reject: reject2, timer: null, cmd: String(cmd) };
          if (ms) rec.timer = setTimeout(() => {
            if (!pending.has(id)) return;         // 已经有结论了（响应先到），这条计时器就是余数
            pending.delete(id);
            reject2(noRetryError("子进程未在 " + ms + "ms 内应答：" + cmd, cmd));
          }, ms);
          pending.set(id, rec);
          // 只有「真没写出去」才判未投递。背压（"queued"）时帧已进 socket 自己的发送队列，照常等回执——
          // 误判成未投递会让调用方以为命令没跑，而它可能已经在子进程里落了库。
          const wf = writeFrame(sock, { k: "req", id, cmd: String(cmd), args: args || {} });
          if (wf === "unwritable" || wf === "unencodable") {
            // 两态的共同点：一字节都没入队，命令绝无可能在子进程里跑过——不存在「已落库却报未投递」
            // 的误判面，所以立即改判（Task 5 刀 1：旧版借 sock.writable 反推，编帧失败被静默吞掉，
            // pending 要挂满默认超时才有结论）。两者错文分开报，排障时才分得清是参数烂还是对端断了。
            if (rec.timer) clearTimeout(rec.timer);
            pending.delete(id);
            reject2(noRetryError(wf === "unencodable"
              ? "命令帧编码失败（参数不可 JSON 序列化），未投递：" + cmd
              : "命令帧未能写入管道，未投递：" + cmd, cmd));
          }
        }),
        onEvent: (cb) => { eventCbs.add(cb); return () => eventCbs.delete(cb); },
        unref: () => { try { sock.unref(); } catch { /* 已断 */ } },
        close: () => { drop(new Error("管道已主动关闭")); },
      };
    };
    attempt();
  });
}

// __hooks：只给闸（scripts/dev-gateway-pipe-test.cjs ⑨c）钉「writeFrame 四态逐态如约」这条不变式——
// 它没有别的确定性入口（OS 的断连时序窗口抓不住）。与 secretbox.__selfCheck 同类的测试可见性：
// 产品路径（gateway.cjs / gateway-client.cjs）一个都不引用它，也不写任何状态。
// noRetryError 则是**产品路径共用的**错误形状：gateway-client.call() 的「未连接」早退也走它（闸 ⑨h）。
module.exports = { serve, connect, noRetryError, __hooks: { writeFrame } };
