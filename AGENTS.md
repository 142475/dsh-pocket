# AGENTS.md

给在本仓库里干活的 AI / 协作者看的约定（人看的说明见 `README.md`，本地开发见 `LOCAL-DEV.md`）。

## 这是什么

dsh-pocket：给 DeepSeek Harness 套一层带访问密码的代理（局域网 / 公网 / Cloudflare 隧道 / 自建 frp）。
本目录是本地 fork（`142475/dsh-pocket`），DSH profile 用 `link:` 指到这里，改完代码重启宿主即生效。

## 常用命令

```bash
npm test                 # node --test 全量用例（改了 lib/ 或 test/ 必跑）
node client/build.mjs    # 只有改了 client/index.jsx 才需要；产物 client/client.js 要一起提交
```

端到端验证：起一个临时端口的小代理打到真实上游（别动用户正在用的 3080/3081），再 `curl -i` 看响应头 / 行为。

## 约定

- 只改后端 `lib/*.mjs` 时不需要重构建前端产物。
- 远端：`origin` = 上游作者仓库 `shaobeichen/dsh-pocket`（**无推送权限**）；推自己的改动一律用 `fork` = `142475/dsh-pocket`。
- 提交信息用中文，形如 `feat(proxy): …` / `fix(tunnel): …`。
- `npm test` 必须全绿（`exit 0`）。本机 Windows 上会有 3 个用例显示 `skipped`，那是平台限制而非失败，原因写在 `LOCAL-DEV.md`。
- 代理 / 隧道这类行为改动，除了单元测试，尽量再做一次真实端到端验证（临时端口 → 真实上游）。
- 改 `frpConfigToml()` 生成配置时：字段归属先拿 frpc 自己验，别照文档猜 —— `frpc verify -c <toml>`（本机 `C:\Users\JF\.dsh\dsh-pocket\bin\frpc.exe`，0.71.0）。实测 `transport.useCompression` 是**每代理**选项，必须写在 `[[proxies]]` 表里；写到顶层 `transport` 会 `json: unknown field "useCompression"` 启动失败。
- 写 WS 相关用例：上游桩回程必须发**合法的未掩码帧**（把客户端带掩码的帧原样 echo 回去，浏览器/undici 判协议错误后 5ms 内 RST，测试挂死）；上游 upgrade socket 要自己挂 `socket.on('error', ...)`，否则代理 teardown 的 RST 会变成 uncaughtException 把测试进程带崩；`node --test` 有残留句柄时不退出，本地调试加 `--test-force-exit`。
- Windows 本机注意：写完文件确认没被亿赛通重新加密（文件头变 `62 14 23 65` 就是被加密了，要右键解密）。
