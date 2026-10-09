// 反代网关 · Qoder 双区端点表（唯一真相源）
//
// 为什么单独一个模块：qoder 有两条签名路（上游 wasm 路读 rules/headers.json 与 qoderAuth，
// fork 的纯 JS 自签路读 qoderSelfSign.REGIONS），而国际版的推理网关此前**三处写了两个值**：
//   rules.cjs 种子    qoder_intl.gateway = https://api2.qoder.sh
//   qoderAuth        qoder_intl.gateway = https://api2.qoder.sh
//   qoderSelfSign    REGIONS.global.gateway = https://api3.qoder.sh/
// CN 三处同值（gateway.qoder.com.cn），所以这处分叉从没被跑到——qoder_intl 至今没注册。
//
// 收口方式不是「三处统一成一个常数」：参考实现 agent2api 的 endpoints.rs:89-113 证明国际版
// **本来就有两台推理主机**（api3 认设备流令牌、api2 认 PAT 换来的 jt- 作业令牌），合并成一台
// 会把 PAT 形态的号打死。所以真相源给的是「区 → 两台主机 + 按令牌选哪台」，见 inferenceBase。
//
// 本模块零 require：qoderAuth / qoderSelfSign / rules / discovery 都可以指过来而不成环
// （adapters.cjs:4325 记过循环 require 拿到半初始化模块的教训）。
//
// 核验状态：api3/api2 的分流是从参考仓的实测结论移植的（它引 9router、CLIProxyAPI 的
// qoder2api 插件与 OmniRoute issue #4683），**本仓还没用真国际版账号打过**。
// scripts/dev-qoder-endpoints-test.cjs 的 G 组钉住取值与「两条签名路都读它」，
// 真账号那次只需验一件事：jt- 落 api2 是否真通。
"use strict";
const path = require("node:path");
const os = require("node:os");

/** 地区 → 域名四组。`gateway` **不带尾斜杠**（与 rules/headers.json、qoderAuth 的既有口径一致）；
 *  自签路要的是 `${gateway}/${PATH}`，用 chatBase() 取，别在调用点拼斜杠。
 *  `jobGateway` = 作业令牌（`jt-`）专用的推理主机：国际版有两台，中国版只有一台，
 *  所以 cn 区两值相同（照抄 gateway）。取值来源见下方 inferenceBase 的注释。 */
const REGIONS = {
  global: { openApi: "https://openapi.qoder.sh", center: "https://center.qoder.sh", webOrigin: "https://qoder.com", gateway: "https://api3.qoder.sh", jobGateway: "https://api2.qoder.sh" },
  cn: { openApi: "https://openapi.qoder.com.cn", center: "https://gateway.qoder.com.cn", webOrigin: "https://qoder.com.cn", gateway: "https://gateway.qoder.com.cn", jobGateway: "https://gateway.qoder.com.cn" },
};

/** 作业令牌前缀：PAT 经 `/api/v1/jobToken/exchange` 换来的那族访问令牌。
 *  设备流（`dt-`）与本应用网页登录拿到的 JWT 都不匹配它，因此默认落主网关。 */
const JOB_TOKEN_PREFIX = "jt-";

/** 地区由**渠道 id** 决定（与上游 qoderAdapter/qoderAuth 的 product 分区同口径），不由登录参数决定 */
const PRODUCT_REGION = { qoder: "cn", qoder_intl: "global" };

/** 客户端主目录：国际版写 ~/.qoder，CN 写 ~/.qoder-cn（与 qoderAuth.PRODUCTS[*].homeDir 同一套） */
const PRODUCT_HOME = { qoder: ".qoder-cn", qoder_intl: ".qoder" };

const regionOf = (product) => PRODUCT_REGION[product] || "global";
const region = (product) => REGIONS[regionOf(product)];

/** 推理网关（无尾斜杠）：wasm 路与 rules 种子用 */
const inferGateway = (product) => region(product).gateway;
/** 推理基址（无尾斜杠，按账号令牌种类定夺）。
 *
 *  为什么国际版有两台：参考实现 agent2api 的 `endpoints.rs:89-113` 记的是上游约束而不是取舍——
 *  `api3.qoder.sh` 认设备流令牌（`dt-`，以及本应用网页登录换来的 JWT 形态），而 PAT 经
 *  `jobToken/exchange` 拿到的作业令牌（`jt-`）只有 `api2.qoder.sh` 认；把 `jt-` 打到 api3
 *  上游判「Login expired」403。中国版只有一台网关，两种令牌都收，所以那边两值相同。
 *
 *  `override` 是 headers.json 里用户手填的 gateway：它只覆盖主网关那一档。jt- 的落点是
 *  协议约束不是偏好——让它被覆盖就会出现「填了域名反而永远 403」且无从解释。 */
const inferenceBase = (product, accessToken, override) => {
  const r = region(product);
  if (String(accessToken || "").startsWith(JOB_TOKEN_PREFIX)) return r.jobGateway;
  return override || r.gateway;
};
/** 推理基址（带尾斜杠）：自签路按 `${chatBase}${PATH}` 拼接，PATH 不带前导斜杠。
 *  不传 accessToken 时等价于主网关（目录种子/无账号场景没有令牌可判）。 */
const chatBase = (product, accessToken, override) => inferenceBase(product, accessToken, override) + "/";
/** 机器标识文件：签名与续期都要用，必须与该产品客户端自己的目录同源 */
const machineIdFileOf = (product) => path.join(process.env.USERPROFILE || os.homedir(), PRODUCT_HOME[product] || ".qoder", ".auth", "machine_id");

module.exports = { REGIONS, PRODUCT_REGION, PRODUCT_HOME, JOB_TOKEN_PREFIX, regionOf, inferGateway, inferenceBase, chatBase, machineIdFileOf };
