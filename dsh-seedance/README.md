# dsh-seedance

把火山方舟的 **Seedance** 变成 DSH 的原生工具：对话里说「生成一段 5 秒的海边日落」，模型自己提交任务、轮询、把 mp4 下载到工作区，并给出**能直接点的播放链接**。

- 形态：DSH 原生插件（bundle），不是 MCP、不是外部脚本、不起子进程
- 宿主：`~/.dsh/profiles/<profile>`（`link:` 或本地路径安装）
- 上游：`https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks`
- 工具：`seedance_generate` / `seedance_check` / `seedance_cancel` / `seedance_list`

```
DSH 会话
 └─ dsh-seedance 插件（宿主进程内）
      ├─ 提交/轮询 Ark 视频任务
      ├─ 成功后立刻下载到 <workspace>/outputs/seedance/
      └─ GET /dsh-seedance/media/<taskId>  ← 聊天里的播放链接（支持 Range，可拖进度）
```

---

## 一、安装

```powershell
git clone https://github.com/<you>/dsh-seedance.git
dsh plugin --profile <profile> add ./dsh-seedance
```

装完**重启 DSH**（客户端面板只在启动时注册）。之后输入框左侧出现 🎬，工具表里出现 `seedance_*`。

要求：DSH 0.x（`@deepseek-ai/dsh-tools` 0.2.x 实测）、Node ≥ 22。

## 二、填 API Key（唯一必做的一步）

编辑：

```
~/.dsh/dsh-seedance/config.json
```

```json
{ "apiKey": "ark-你的key" }
```

保存即可，**不用重启**——插件每次调用都会检查文件修改时间。
Key 在[火山方舟控制台 → API Key](https://console.volcengine.com/ark) 创建，并确认账号已开通 Seedance 模型。

> 也可以用环境变量 `ARK_API_KEY`；但 DSH 启动时的环境里通常没有，所以推荐上面的文件。

---

## 三、工具

| 工具 | 作用 | 关键参数 |
| --- | --- | --- |
| `seedance_generate` | 文生视频 / 首帧 / 首尾帧 / 多图参考 | `prompt`、`images[]`、`preset`、`ratio`、`duration`、`resolution`、`audio`、`waitSec`、`dryRun` |
| `seedance_check` | 查进度、等一会儿、成功后自动下载 | `taskId`、`waitSec`、`download` |
| `seedance_cancel` | 取消排队/生成中的任务 | `taskId` |
| `seedance_list` | 列最近任务（本地记录） | `limit`、`status` |

### preset 档位

| preset | 模型 | 分辨率 | 时长 |
| --- | --- | --- | --- |
| `draft` | `doubao-seedance-2-0-fast-260128` | 480p | 5s |
| `standard`（默认） | `doubao-seedance-2-0-260128` | 720p | 5s |
| `high` | `doubao-seedance-2-5-260628` | 1080p | 8s |

> **开通是按模型算的**：火山方舟「开通管理」里开通的是哪个，就只能在哪个上用。
> 如果账号只开通了标准模型（例如 `doubao-seedance-2-0-260128`），可以在 profile patch 里加一行
> `model: doubao-seedance-2-0-260128` 固定住，或在面板「设置 → 默认模型」里改；
> 开通 fast / 2.5 之后删掉这行、或换成对应 ID 即可。
> 未开通时会直接返回中文提示，不会扣费。

分辨率/时长还会被配置上限（`maxResolution` / `maxDuration`）夹取，并在返回消息里说明「已降档」。

### 图片入参

- 1 张 → 首帧（`first_frame`）
- 2 张 → 首尾帧（`first_frame` + `last_frame`）
- 3–4 张 → 参考图（`reference_image`，仅 2.x）
- 支持本地绝对路径（自动转 base64，≤10MB）或 `https://` 链接

---

## 四、产物

```
<workspace>/outputs/seedance/2026-10-19-rainy-street-cgt-xxxx.mp4
```

- 下载成功后任务状态变 `downloaded`，返回里带 `videoPath` 和 `mediaUrl`
- `mediaUrl` 形如 `http://127.0.0.1:<GUI 端口>/dsh-seedance/media/cgt-xxxx`，浏览器可直接播放、拖进度
- Ark 的视频地址约 24 小时过期，所以成功即下载，不延迟

### 已验证的真实产物（2026-10-19）

| 场景 | 参数 | 耗时 | 文件 |
| --- | --- | --- | --- |
| 文生视频 | 2.0 / 720p / 4s / 16:9 | 141s | `outputs/seedance/2026-10-19-lamp-smoke-cgt-20261019225846-xhcmb.mp4`（1.6MB） |
| 首帧图生视频 | 2.0 / 480p / 4s / adaptive | 151s | `outputs/seedance/2026-10-19-lamp-i2v-cgt-20261019230233-fz5pg.mp4`（0.76MB） |

两条都验证了：MP4 文件头 `ftypisom`、HTTP 200 `video/mp4`、Range 206。

---

## 五、配置项

优先级：工具参数 > profile patch 配置 > `~/.dsh/dsh-seedance/config.json`（面板写这里，Key 也在里面）> 默认值。

在 `~/.dsh/profiles/<profile>/cordis.patch.yml` 里加：

```yaml
- id: dsh-seedance
  name: dsh-seedance
  config:
    maxResolution: 1080p   # 480p | 720p | 1080p | 4k
    maxDuration: 12
    maxPerDay: 20
    defaultWaitSec: 90
    autoDownload: true
    promptEnabled: true    # 是否注入"何时该生成视频"的系统提示
    outputDir: outputs/seedance
```

改完自动热重载（DSH 会重新应用这一行），不用重启。

---

## 六、开发

```powershell
# 用 DSH 自带的 node（Windows 在 ~/.dsh/dsh-runtimes/... 下），或系统里的 node
node --test "test/*.test.mjs"
```

- 47 项测试：参数夹取、1.x/2.x 请求体、状态映射、Range、下载清理、幂等、失败语义、Key 文件、配置合并、用量统计
- `test/fixture.mjs` 会把 `index.js` + `lib/` 拷到临时目录并放最小 SDK stub，**源码目录里不留 `node_modules`**
- 改完宿主代码后，触碰一次 `cordis.patch.yml` 里的 `dsh-seedance` 行即可热重载

## 七、可视化面板

输入框左侧有一个 **🎬** 按钮（和表情包按钮同一排），点开是三页浮层：

| 页签 | 内容 |
| --- | --- |
| **任务** | 最近 50 条：首帧缩略图、状态、提示词、模型/时长/分辨率/token、播放、下载、取消；顶部显示今日/本月条数、秒数、token |
| **设置** | API Key（掩码显示、可清除）、Base URL、默认模型、分辨率上限、时长上限、每日条数、默认等待、输出目录；保存即生效 |
| **模型** | 从火山方舟拉 Seedance 目录；「可用 / 未开通 / 未验证」按历史任务推断，点「设为默认」直接切换 |

- 底部**测试连接**：只调 `/models`，零费用，返回延迟与模型数量
- 数据走同源 HTTP：`GET /dsh-seedance/api/state`、`POST /config|/test|/models|/cancel`（仅本机回环）
- **面板是客户端半边，DSH 启动时才注册**：第一次加面板要重启 DSH；之后改 `client.js` 刷新页面（Ctrl+R）即可

## 八、故障排查

| 现象 | 处理 |
| --- | --- |
| 工具没出现 | 确认 `~/.dsh/profiles/<profile>/package.json` 的 `dsh.profile.bundles` 里有 `dsh-seedance` |
| 🎬 按钮没出现 | 刷新页面；仍没有就重启 DSH（客户端半只在启动时注册） |
| `NO_API_KEY` | 填 `~/.dsh/dsh-seedance/config.json`，或在面板「设置」里填 |
| `HTTP 401/403` | Key 无效或没开通模型 |
| `HTTP 404` | 模型 ID 未开通，换控制台里可用的 ID |
| `HTTP 400` | 参数组合不支持（时长/分辨率超限、首帧 + `adaptive` 等） |
| 一直是 `running` | 正常，5s/1080p 约 1–3 分钟；用 `seedance_check` 续查，别重复提交 |
| 视频打不开 | 确认 `mediaUrl` 的端口是当前 GUI 端口；文件是否被移动 |

---

## 免责声明

本项目与 DeepSeek、火山引擎均无隶属关系。生成调用按火山方舟计费；插件里的分辨率/时长/条数上限只是护栏，不构成费用承诺。
