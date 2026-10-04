# 本地联调（开发软链）

改完代码想在本机 dsh web 里直接验证，**不用发版**——把已安装的插件换成指向本地仓库的软链即可。

原理：dsh 的插件装在 profile 的 `node_modules` 里（pnpm 软链），我们把它重新指向本地仓库目录，dsh web 重启后就加载本地代码。

---

## 一、建立软链（只需做一次）

```sh
# 插件安装位置：$DSH_HOME/profiles/web/node_modules/dsh-pocket（默认 $DSH_HOME=~/.dsh）
# 若你改过 DSH_HOME，把下面的 ~/.dsh 换成实际路径
cd ~/.dsh/profiles/web/node_modules

rm dsh-pocket
ln -s /你的/仓库/绝对路径/dsh-pocket dsh-pocket

# 确认
ls -l dsh-pocket
# dsh-pocket -> /你的/仓库/绝对路径/dsh-pocket
```

桌面版 profile 同理，把路径里的 `web` 换成 `desktop` 即可。

## 二、日常改代码流程

| 改了哪里 | 要做什么 |
| --- | --- |
| `lib/**`（后端） | 直接重启 dsh web 生效 |
| `client/**`（前端源码） | 先 `node client/build.mjs` 打包，再重启 dsh web |

```sh
node client/build.mjs     # 改了 client/** 必跑（只改后端可跳过）
npm test                  # 建议顺手跑一遍（当前 207 个用例）
```

### 重启 dsh web

直接 `kill` 后用 `nohup` 拉起**会被终端会话回收**，必须用 detached 方式（和插件自带的自重启同一套做法）：

```sh
# 1) 停掉当前 dsh web
kill $(lsof -ti :3080 -sTCP:LISTEN)

# 2) detached 重新拉起（日志在 /tmp/dsh-web-dev.log）
node -e "
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const out = fs.openSync('/tmp/dsh-web-dev.log', 'a');
const err = fs.openSync('/tmp/dsh-web-dev.log', 'a');
spawn('$(command -v dsh)', ['web'], {
  detached: true, stdio: ['ignore', out, err], env: process.env, cwd: process.env.HOME,
}).unref();
"

# 3) 等服务起来
curl -s -o /dev/null -w "3080:%{http_code}\n" http://127.0.0.1:3080/   # dsh web
curl -s -o /dev/null -w "3081:%{http_code}\n" http://127.0.0.1:3081/   # dsh-pocket 代理
```

## 三、确认加载的确实是本地代码

页面引用的 `client.js` 带一个 `rev` 参数，它是打包产物内容的 sha1 前 12 位。比对一下就知道有没有生效：

```sh
# 页面正在引用的版本
REV=$(curl -s http://127.0.0.1:3080/ | grep -o 'dsh-pocket/client.js?rev=[a-f0-9]*' | head -1 | cut -d= -f2)
echo $REV

# 本地打包产物的 sha1 前 12 位
shasum -a 1 client/client.js | cut -c1-12
```

两者一致 = 本地代码已生效。

## 四、换回 npm 官方版本

```sh
dsh plugin --profile web add dsh-pocket -w
```

重装会把软链换回 pnpm 的正式安装：

```sh
ls -l ~/.dsh/profiles/web/node_modules/dsh-pocket
# dsh-pocket -> .pnpm/dsh-pocket@<版本>/node_modules/dsh-pocket
```

之后重启 dsh web 即可。

---

## 注意事项

- **软链期间，你日常用的 dsh web 跑的都是本地仓库代码**（包括未提交的改动），而别人通过 npm 装到的仍是发布版——两边互不影响。
- 本地仓库需要装过依赖（`npm install`），否则 `lib/` 用到的 `cordis` / `cosmokit` 等解析不到，插件会静默加载失败。
- 改完 `client/` 忘了打包，界面不会变（dsh web 加载的是 `client/client.js` 产物，不是 `index.jsx` 源码）。
- 电脑重启后自己正常启动 dsh web 即可，软链是持久的，仍然加载本地代码。
- **Windows 上会有 3 个用例显示 `skipped`（不是失败）**，套件整体仍 `exit 0`：
  - `download.test.js` 的「Linux 上丢弃 Homebrew bottle 坏缓存」：该分支本身只存在于 Linux，其它平台会走去下载 cloudflared，无外网时四个镜像轮流超时把用例拖到 60s 超时；
  - `tunnel-args.test.js` 的两个 `--no-autoupdate` 位置用例：假 cloudflared 是带 shebang 的 JS，靠「无扩展名直接执行」跑起来，Windows 的 CreateProcess 不补 PATHEXT，必 ENOENT。同一回归由同文件里的 `--no-autoupdate 位置契约（跨平台源码断言）` 兜住。

## 常见问题

**手机页面没变化**：多半是忘了 `node client/build.mjs`，或 dsh web 没重启成功（看 `/tmp/dsh-web-dev.log`）。

**代理端口 3081 起不来**：插件没加载成功。检查软链路径是否正确、仓库依赖是否装好；也可以 `curl -s http://127.0.0.1:3080/` 看返回的 HTML 里有没有 `dsh-pocket/client.js`。

**端口被占**：`lsof -ti :3080` 或 `lsof -ti :3081` 查占用进程；dsh-pocket 的代理在 3081 被占时会自动顺延到下一个端口。
