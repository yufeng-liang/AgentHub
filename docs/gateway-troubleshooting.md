# 网关凭据后端与首启

打包首启若报「凭据解密失败：打包环境既无 safeStorage 也无本机 v10 主密钥」，先确认同目录是否已生成
`Local State`（Chromium 建完 profile 才落盘）；子进程早于它启动会判 `none` 并 fatal 退出（实测竞速窗口
8–12s），重开一次设置页的启动服务即可。
