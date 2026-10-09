// 反代网关 · Qoder 双区端点表（唯一真相源）
//
// 为什么单独一个模块：qoder 有两条签名路（上游 wasm 路读 rules/headers.json 与 qoderAuth，
// fork 的纯 JS 自签路读 qoderSelfSign.REGIONS），而国际版的推理网关此前**三处写了两个值**：
//   rules.cjs 种子    qoder_intl.gateway = https://api2.qoder.sh
//   qoderAuth        qoder_intl.gateway = https://api2.qoder.sh
//   qoderSelfSign    REGIONS.global.gateway = https://api3.qoder.sh/
// CN 三处同值（gateway.qoder.com.cn），所以这处分叉从没被跑到——qoder_intl 至今没注册。
// 一注册就会变成「一条路通、另一条路 404」，且只在签名器回落（未装客户端）时才现。
//
// 本模块零 require：qoderAuth / qoderSelfSign / rules / discovery 都可以指过来而不成环
// （adapters.cjs:4325 记过循环 require 拿到半初始化模块的教训）。
//
// 取值依据：参考实现的 endpoints.rs 四组域名表（Global 的 /algo 推理网关是 api3），
// 见 docs/superpowers/specs/2026-09-22-new-providers-protocol-ref.md:395。
// ⚠ 这是**未用真账号验过**的选择：若国际版真账号下 api3 回 404 而 api2 通，只改本文件
//   global.gateway 一个常数即可，scripts/dev-qoder-endpoints-test.cjs 会保证四条读它的
//   链路一起跟上。
"use strict";
const path = require("node:path");
const os = require("node:os");

/** 地区 → 域名四组。`gateway` **不带尾斜杠**（与 rules/headers.json、qoderAuth 的既有口径一致）；
 *  自签路要的是 `${gateway}/${PATH}`，用 chatBase() 取，别在调用点拼斜杠。 */
const REGIONS = {
  global: { openApi: "https://openapi.qoder.sh", center: "https://center.qoder.sh", webOrigin: "https://qoder.com", gateway: "https://api3.qoder.sh" },
  cn: { openApi: "https://openapi.qoder.com.cn", center: "https://gateway.qoder.com.cn", webOrigin: "https://qoder.com.cn", gateway: "https://gateway.qoder.com.cn" },
};

/** 地区由**渠道 id** 决定（与上游 qoderAdapter/qoderAuth 的 product 分区同口径），不由登录参数决定 */
const PRODUCT_REGION = { qoder: "cn", qoder_intl: "global" };

/** 客户端主目录：国际版写 ~/.qoder，CN 写 ~/.qoder-cn（与 qoderAuth.PRODUCTS[*].homeDir 同一套） */
const PRODUCT_HOME = { qoder: ".qoder-cn", qoder_intl: ".qoder" };

const regionOf = (product) => PRODUCT_REGION[product] || "global";
const region = (product) => REGIONS[regionOf(product)];

/** 推理网关（无尾斜杠）：wasm 路与 rules 种子用 */
const inferGateway = (product) => region(product).gateway;
/** 推理网关（带尾斜杠）：自签路按 `${chatBase}${PATH}` 拼接，PATH 不带前导斜杠 */
const chatBase = (product) => inferGateway(product) + "/";
/** 机器标识文件：签名与续期都要用，必须与该产品客户端自己的目录同源 */
const machineIdFileOf = (product) => path.join(process.env.USERPROFILE || os.homedir(), PRODUCT_HOME[product] || ".qoder", ".auth", "machine_id");

module.exports = { REGIONS, PRODUCT_REGION, PRODUCT_HOME, regionOf, inferGateway, chatBase, machineIdFileOf };
