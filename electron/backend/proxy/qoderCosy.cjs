// Qoder COSY 自签名（协议参考 §3.3；常量逐字抄自参考 cosy.rs:52-82，一个字符都不能改）。
// 请求体必须先 encodeBody 后 buildCosyHeaders（签的是编码后字节），顺序颠倒只报「签名不匹配」无从排查。
"use strict";
const crypto = require("node:crypto");

const GATEWAY_COSY_VERSION = "1.1.38";
const CLIENT_TYPE = "5";
// RSA-1024 公钥（模数 1024 位 hex、指数 65537）：用于加密一次性 AES key
const RSA_MODULUS_HEX = "c0f22307e5cd362e296bb04470f6de8fbf935ce24e8fcf511a0e2701329769c4a76e499bb938036a52af1eaf818cf79a2600620e3ce87e371d2ca6d85803606a1b3fa5e874643c9ed2db7e85673ef7227fca56e2e7c08f0927609bb896a9f24be1782099a66016a5bfdc3f1ff756bfc9e88d7b5dc5be30bf45a0223a00ebcecf";
const STD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const CUSTOM_ALPHABET = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";

function md5hex(s) { return crypto.createHash("md5").update(String(s), "utf8").digest("hex"); }

/** URL 的 path 去掉 /algo 前缀、不含查询串（协议参考 §3.3 第 6 步） */
function sigPathOf(url) {
  const u = new URL(String(url));
  const p = u.pathname;
  return p.startsWith("/algo") ? p.slice(5) || "/" : p;
}

/** encode_body 三步变换（cosy.rs:212-240 逐字移植）：标准 base64 → 尾段/中段/首段重排
 *  （各段 ⌊n/3⌋，余数留在中段）→ 逐字符字母表替换（'=' → '$'）。 */
function encodeBody(jsonBytes) {
  const b64 = Buffer.from(jsonBytes).toString("base64");
  const n = b64.length;
  const third = Math.floor(n / 3);
  const rotated = b64.slice(n - third) + b64.slice(third, n - third) + b64.slice(0, third);
  let out = "";
  for (const ch of rotated) {
    if (ch === "=") { out += "$"; continue; }
    const i = STD_ALPHABET.indexOf(ch);
    out += i >= 0 ? CUSTOM_ALPHABET[i] : ch;
  }
  return Buffer.from(out, "latin1");
}

/** 随机 16 字符 AES key（源实现：32B 随机 base64url 取前 16 ASCII；key 与 iv 同一段） */
function randomAesKey() { return crypto.randomBytes(16).toString("base64url").slice(0, 16); }

function rsaEncryptKey(aesKey) {
  const jwk = { kty: "RSA", n: Buffer.from(RSA_MODULUS_HEX, "hex").toString("base64url"), e: "AQAB" };
  const pub = crypto.createPublicKey({ key: jwk, format: "jwk" });
  // PKCS#1 v1.5（node 默认 padding），1024 位模数天然输出定长 128 字节
  return crypto.publicEncrypt({ key: pub, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(aesKey, "utf8")).toString("base64");
}

/** 身份 JSON：键序照抄源实现、手写拼接（键序参与加密与签名），值是 JSON 字符串转义形态 */
function identityJson({ uid, token, name, email }) {
  return `{"uid":${JSON.stringify(String(uid))},"security_oauth_token":${JSON.stringify(String(token))},"name":${JSON.stringify(String(name))},"aid":"","email":${JSON.stringify(String(email))}}`;
}

/** build 全套 COSY 头（协议参考 §3.3 第 9 步头集合，逐字）。body 必须是编码后的 Buffer。 */
function buildCosyHeaders({ url, body, uid, token, name, email, machineId, requestId }) {
  const aesKey = randomAesKey();
  const keyBuf = Buffer.from(aesKey, "utf8");
  const cipher = crypto.createCipheriv("aes-128-cbc", keyBuf, keyBuf); // key=iv 同一段（源实现既有做法）
  const info = Buffer.concat([cipher.update(Buffer.from(identityJson({ uid, token, name, email }), "utf8")), cipher.final()]).toString("base64");
  const payload = `{"version":"v1","requestId":${JSON.stringify(String(requestId))},"info":${JSON.stringify(info)},"cosyVersion":${JSON.stringify(GATEWAY_COSY_VERSION)},"ideVersion":""}`;
  const payloadB64 = Buffer.from(payload, "utf8").toString("base64");
  const cosyKey = rsaEncryptKey(aesKey);
  const ts = Math.floor(Date.now() / 1000); // 秒
  const sigPath = sigPathOf(url);
  const bodyStr = body.toString("latin1"); // 编码后字节（全 ASCII，latin1 无损）
  const signature = md5hex([payloadB64, cosyKey, String(ts), bodyStr, sigPath].join("\n"));
  return {
    "authorization": `Bearer COSY.${payloadB64}.${signature}`,
    "cosy-key": cosyKey,
    "cosy-user": String(uid),
    "cosy-date": String(ts),
    "cosy-version": GATEWAY_COSY_VERSION,
    "cosy-machineid": String(machineId || ""),
    "cosy-machinetoken": String(machineId || ""), // 与 machineid 同值
    "cosy-machinetype": CLIENT_TYPE,
    "cosy-machineos": "x86_64_windows", // {arch}_{platform}；本机恒 x86_64_windows
    "cosy-clienttype": CLIENT_TYPE,
    "cosy-clientip": "127.0.0.1",
    "cosy-bodyhash": md5hex(bodyStr),
    "cosy-bodylength": String(Buffer.byteLength(bodyStr, "latin1")),
    "cosy-sigpath": sigPath,
    "cosy-data-policy": "disagree",
    "cosy-organization-id": "",
    "cosy-organization-tags": "",
    "login-version": "v2",
    "x-request-id": String(requestId),
  };
}

module.exports = { GATEWAY_COSY_VERSION, encodeBody, buildCosyHeaders, sigPathOf, md5hex, randomAesKey, rsaEncryptKey };
