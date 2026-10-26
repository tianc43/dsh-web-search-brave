# dsh-web-search-brave

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的 web seam 增加 **Brave Web Search** 后端。安装后 agent 的 `web_search` 工具就走 Brave Search API，不再依赖 DSH 内置的 DeepSeek / Exa / Perplexity 搜索。

这是一个标准 DSH **bundle 插件**：`cordis.patch.yml` 负责把 `ctx.web` 的搜索后端钉到 `brave`，`index.js` 提供 provider 实现。

## 特性

- 通过 `ctx.web.registerSearchProvider()` 注册 id 为 `brave` 的搜索后端；
- 把 Brave 返回的 `web.results` 规范化成 DSH 的 `{ url, title, snippet, publishedAt }`；
- 内置 HTTP CONNECT 代理隧道（`proxy` 配置或 `HTTPS_PROXY` / `HTTP_PROXY`），**不安装进程级 dispatcher**，因此不会顺手把你的模型请求也塞进代理；
- API key 走 DSH 凭证系统（默认引用 `BRAVE_API_KEY`），**每次搜索时解析**，换 key 不需要重启；
- 零运行依赖，只用 Node 内置模块（`node:https` / `node:net` / `node:tls`）。

## 环境要求

- DSH `>=0.2.0 <0.3.0`（`engines.dsh` 已声明）；
- Node.js 20+；
- 一个 Brave Search API key（在 [Brave Search API 控制台](https://api-dashboard.search.brave.com/) 获取，有免费额度）。

## 安装

```bash
# 1) 直接从 GitHub 安装（推荐）
dsh plugin --profile web add github:tianc43/dsh-web-search-brave

# 2) 从本地目录安装（开发/离线）
dsh plugin --profile web add D:\path\to\dsh-web-search-brave

# 3) 从 tarball 安装
dsh plugin --profile web add https://github.com/tianc43/dsh-web-search-brave/archive/refs/heads/main.tar.gz
```

安装会在 profile 的 `package.json` 里加入依赖和 bundle 条目，bundle 自带的补丁层随即生效：

```yaml
- id: web
  name: '@deepseek-ai/dsh-web'
  config:
    searchProvider: brave
    fetchProvider: http

- insert:
    - id: web-search-brave
      name: dsh-web-search-brave
```

安装完**重启一次** `dsh web`（或你用的入口）让 loader 重新组装。

## 配置 API key

写进 DSH 凭证文件 `~/.dsh/.credentials.yaml`（Windows 上是 `C:\Users\<你>\.dsh\.credentials.yaml`）：

```yaml
version: 1
refs:
  BRAVE_API_KEY: 你的key
```

也可以直接用环境变量 `BRAVE_API_KEY`。解析顺序：`config.apiKey`（明文，不推荐）→ `ctx.credentials.resolve(config.apiKeyEnv)` → 环境变量。

**不要把 key 写进任何提交到 Git 的文件。**

## 可选配置

机器相关的设置写在 profile 自己的 `cordis.patch.yml`（用户补丁层，最后应用）：

```yaml
- id: web-search-brave
  config:
    proxy: http://127.0.0.1:7890
    count: 10
    searchLang: zh-hans
```

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `apiKeyEnv` | `BRAVE_API_KEY` | 凭证引用名 |
| `apiKey` | — | 直接给明文 key（不推荐，建议用凭证） |
| `baseURL` | `https://api.search.brave.com/res/v1` | 换自建网关/镜像时用 |
| `count` | `10` | 默认结果条数，Brave 上限 20 |
| `country` | — | Brave `country` 参数，如 `CN` |
| `searchLang` | — | Brave `search_lang` 参数，如 `zh-hans` |
| `safesearch` | — | Brave `safesearch` 参数，如 `moderate` / `off` |
| `proxy` | `HTTPS_PROXY` → `HTTP_PROXY` → 直连 | HTTP CONNECT 代理地址 |
| `timeoutMs` | `30000` | 单次请求超时 |

`NO_PROXY`（环境变量）对 `proxy` 生效：命中列表的域名会直连。

### 代理说明

Brave API 在部分网络（如中国大陆）无法直连，通常需要本机代理：

- 如果 DSH 进程环境里已有 `HTTPS_PROXY`，什么都不用配；
- 否则在 profile 补丁里加 `proxy: http://127.0.0.1:7890`（Clash 默认端口）之类的地址。

代理只在本插件内部使用，不会改变模型调用等其他请求的路由。

## 验证

```bash
# 需要网络；有代理时先 export HTTPS_PROXY
BRAVE_API_KEY=... node test/live-search.mjs "画渣花小烙"
```

输出形如：

```
provider: brave | query: 画渣花小烙 | 1111 ms
- 别靠近科普博主"画渣花小烙"，你会变成"小学生"_腾讯新闻 | https://news.qq.com/rain/a/20220702A01OT200
  "画渣花小烙"就是这样一位生活科普博主……
sources: 3, truncated: false
```

或者在 DSH 里让 agent 搜一次，看返回来源即可。

## 卸载

```bash
dsh plugin --profile web remove dsh-web-search-brave
```

然后从 `~/.dsh/.credentials.yaml` 删除 `BRAVE_API_KEY`，重启 DSH。

## 工作原理

1. `package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`，DSH 组装 profile 时把这个补丁层应用在 bundle 层之后、用户补丁层之前；
2. 补丁把 `id: web` 的 `searchProvider` 钉为 `brave`，并 `insert` 本插件行；
3. loader 加载 `index.js`，调用 `apply(ctx, config)`，provider 注册进 `ctx.web`；
4. `search()` 发 `GET /res/v1/web/search`，把 `web.results[]` 映射为 `sources[]`；
5. 代理场景下由 `ProxyHttpsAgent` 完成 `CONNECT host:443` 握手后再套一层 TLS，因此不需要修改 undici 全局 dispatcher。

## 安全

- 仓库内不含任何密钥；
- key 只存在本机 `~/.dsh/.credentials.yaml` 或环境变量里；
- 请求头只带 `X-Subscription-Token`，不落日志。

## License

MIT © tianc43