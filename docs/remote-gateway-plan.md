# 远程 ChatGPT Web Gateway 改造计划

## 目标

在保留上游 `codex-chatgpt-web` 核心实现的前提下，增加一个面向服务器部署的独立 Gateway 模式，使其能够在 Ubuntu 24.04 + Docker Compose / 1Panel 中运行，并作为 CLIProxyAPI（CPA）的 Codex Responses 上游。

目标调用链：

`CPA codex-api-key provider -> private gateway URL -> codex-chatgpt-web Responses bridge -> authenticated ChatGPT browser session`

此改造不应修改或破坏原有桌面启动器和原生 Codex 集成。

## 关于现有 Linux 发布包

- `codex-chatgpt-web-linux-amd64.tar.gz` 是由 `launcher/build/runtime` 打包的运行时 bundle，内含 Bun、CLI entrypoint、Playwright Core 及应用依赖。
- 当前 `scripts/install.sh` 明确仅支持 macOS；官方 Linux 安装方式是 Electron AppImage 启动器。
- 因此，Linux tarball 的存在不代表当前项目已经提供受支持的 Linux 无桌面服务安装流程。
- Gateway 模式应单独提供安装/容器入口，不应伪装成现有 macOS terminal installer 的简单扩展。

## 设计原则

1. **隔离模式**：新增 `gateway` 运行模式或独立入口，不复用会修改本机 Codex 配置的 setup 路径。
2. **复用核心**：尽可能复用 `responseRequest`、Responses parser、browser adapter、model routing、response-state 和 SSE bridge。
3. **认证默认开启**：所有模型 API、远程登录 UI 和管理端点必须有独立 Bearer token 保护；启动时没有配置密钥应直接失败。
4. **网络默认私有**：容器内监听由环境变量控制；Compose 默认只加入内部网络，不直接发布公网端口。
5. **安全登录**：远程登录 UI 只能在认证后打开；截图、点击、键盘输入和保存登录状态均需验证授权。禁止将 ChatGPT cookie、storage state 或密码写入日志。
6. **持久化**：将配置、浏览器登录状态和会话状态放入独立数据目录，权限最小化，并通过 Docker volume 持久化。
7. **不绕过配额**：此服务只代理用户账号本身允许的网页能力，不承诺突破 ChatGPT 的使用限制。
8. **透明兼容性**：只将已验证的能力声明为支持；未验证的工具调用、图片输入、取消、压缩等行为必须明确标记。

## 当前已知的兼容性风险

- 当前 Responses 服务默认绑定 `127.0.0.1`，且配置解析器强制 loopback；Gateway 模式需新增独立的监听配置，不能直接放宽原生 Codex 模式的安全约束。
- 当前服务处理 `client_metadata["x-codex-turn-metadata"]` 中的 thread/turn identity，并依赖 Codex 语义；CPA 转发请求是否完整保留这些字段，必须通过真实集成测试验证。
- CPA Codex executor 会删除 `previous_response_id`。连续对话是否依赖该字段、能否用 Gateway 管理的状态恢复输入，需要单独验证。
- 当前 Linux terminal installer 不支持 Linux，且当前终端 service installer 仅支持 macOS。Gateway 模式应自行管理前台进程/容器生命周期，不调用 macOS launchd 管理路径。
- 原项目默认未提供通用 API Key 认证；不能把没有认证的 Responses listener 直接暴露给公网或其他不可信网络。

## 分阶段实施

### Phase 0：运行时和协议基线

- 验证 Linux runtime bundle 的文件布局、版本校验和、CLI `--version` 与 `--help`。
- 在 Linux 环境运行静态验证和现有单元测试。
- 建立 CPA Codex executor -> Gateway 的请求样本与兼容性测试，特别关注模型 slug、stream、thread/turn metadata 和 previous response state。

### Phase 1：Gateway 服务骨架

- 新增独立 Gateway 配置 schema 与 CLI 命令。
- 支持 host、port、API key、数据目录、浏览器运行参数和日志级别。
- 新增健康检查、模型列表、认证中间件和安全默认值。
- 不调用 Codex route installation、macOS launchd 或 OpenAI tunnel setup。

### Phase 2：无桌面登录和持久化

- 使用服务器端浏览器进程及虚拟显示运行浏览器。
- 提供受认证的远程登录 UI，支持屏幕查看和有限的鼠标/键盘交互。
- 登录完成后验证 ChatGPT 会话，安全持久化状态；登录状态过期时返回清晰错误并要求重新登录。
- 登录 UI 与模型 API 使用独立权限；禁止无认证的截图/键盘/鼠标控制端点。

### Phase 3：CPA Responses 兼容

- 提供 CPA 所需的 Responses 路径、SSE 事件和错误格式。
- 确认模型列表及 `chatgpt-web/<model-slug>` 路由行为。
- 验证单轮、连续对话、流式、客户端断开/取消、超时与并发。
- 如 CPA 请求缺少原生 Codex 元数据，设计明确的 Gateway 适配逻辑，不伪造或跳过安全上下文验证。

### Phase 4：Docker / 1Panel 部署与文档

- 提供多阶段 Dockerfile、Compose、`.env.example`、持久化卷和健康检查。
- 默认只接入 CPA 可访问的私有 Docker 网络；不发布未认证的公网端口。
- 编写 1Panel 部署、首次登录、升级、备份/恢复和故障排查文档。

## 验收标准

- [ ] Linux x86_64 可通过 Docker Compose 构建并启动。
- [ ] 未认证的 API、登录和控制请求均被拒绝。
- [ ] 登录状态在容器重启后保留。
- [ ] `/healthz` 与 `/v1/models` 行为稳定且不泄露凭据。
- [ ] Responses 非流式请求返回标准 JSON。
- [ ] Responses SSE 请求能返回完整的开始、增量和结束事件。
- [ ] CPA `codex-api-key` 上游的真实集成测试通过。
- [ ] 连续对话、previous response state、工具调用和取消行为分别有测试结果。
- [ ] 原有桌面启动器和 Codex 集成的 CI 测试不回归。
- [ ] 文档明确列出所有未支持的功能和账号风险。

## Linux runtime bundle smoke test (2026-10-27)

The upstream GitHub Actions release artifact was retrieved through the GitHub connector because direct DNS resolution for `github.com` is unavailable in the local execution container.

Artifact provenance:
- Upstream release workflow: [run 40281586918](https://github.com/miuuyy/codex-chatgpt-web/actions/runs/40281586918), successful `v6.1.14` release.
- Linux x64 artifact: `release-ubuntu-latest`, containing `codex-chatgpt-web-linux-amd64.tar.gz` (55,843,241 bytes) and the Linux AppImage.
- Runtime manifest reports app `6.1.14`, Bun `1.4.0`, Linux `x64`, Playwright `1.62.0`, and 4,899 manifest entries.

Executed in an isolated Linux x86_64 container:
- `bin/codex-chatgpt-web --version` -> `6.1.14` (pass).
- `bin/codex-chatgpt-web --help` -> CLI starts and prints help (pass).
- `bin/codex-chatgpt-web service status` -> `supported: false`, `installed: false`, `loaded: false` (expected: terminal service manager is not supported on Linux).
- `setup --browser-only --acknowledge-unofficial --preflight-only` -> exit 1 with: `Terminal-only managed Chrome setup currently requires macOS. Use the Codex Web GPT launcher on Windows or Linux.` (confirms the standard terminal setup path is intentionally blocked on Linux).

Conclusion:
- The Linux `.tar.gz` is a real runnable runtime bundle, not merely documentation; its CLI can start.
- It is **not** a supported headless-server installation flow. The supported Linux lifecycle is owned by the Electron launcher, while terminal-managed service installation is macOS-only.
- No ChatGPT login was performed and no authenticated Responses request was sent in this smoke test.
- Direct GitHub asset download from the execution container failed with `curl: (6) Could not resolve host: github.com`; the artifact was instead retrieved from the successful upstream Actions artifact.

## Official Linux launcher installer smoke test (2026-10-27)

### Network constraint and artifact provenance

- The exact remote command `curl -fsSL https://github.com/miuuyy/codex-chatgpt-web/releases/latest/download/install-launcher.sh | sh` was attempted in the isolated execution container.
- It could not download the script because the container cannot resolve `github.com`: `curl: (6) Could not resolve host: github.com`.
- The v6.1.14 Ubuntu x64 GitHub Actions artifact was retrieved through the GitHub connector. The AppImage SHA-256 computed locally is `59560086b338ce7267df3b29d6347801f11d01b44e8631c644fab3812a886b17`, matching the digest reported by the official GitHub Release API for `codex-web-gpt-6.1.14-linux-x64.AppImage`.
- The official `scripts/install-launcher.sh` was read from the upstream repository. Because network downloads were unavailable, its Linux installation flow was exercised in an isolated temporary HOME using the verified release AppImage and a local download shim. The auto-launch step was stubbed so the test could inspect installation before separately testing startup.

### Results

- AppImage `--appimage-extract`: pass.
- Installer flow: pass; installed the AppImage under `~/.local/lib/codex-web-gpt/6.1.14/`, created `~/.local/bin/codex-web-gpt`, extracted the bounded AppImage runner, and wrote `~/.local/share/applications/codex-web-gpt.desktop`.
- Electron startup under `xvfb-run` as a non-root user: pass in the sense that the process started and exposed a local DevTools endpoint. The app remained running until the 25-second timeout.
- The app attempted to load `https://chatgpt.com/` but received `ERR_NAME_NOT_RESOLVED` because this environment has no DNS access. No ChatGPT login was attempted.
- Running the GUI as root failed as expected because Electron refuses root without `--no-sandbox`; the non-root test is the relevant result.

### Conclusion

The official Linux installer **installs and auto-launches the Electron desktop application**. It does not install a headless Responses server or a system service. It creates a desktop entry and a user-local launcher, and the application expects a graphical session (a virtual display is enough to start the UI process, but does not by itself provide an interactive login surface to the user).

For the planned VPS gateway, we still need a separate server mode and a safe way to complete ChatGPT login remotely. Installing the official launcher alone does not satisfy the CPA gateway goal.

## Architecture decision: standalone Gateway, optional CPA aggregation (2026-10-27)

The Gateway is an independent model API service. CPA is an optional downstream aggregation/control plane, not a runtime dependency of the Gateway.

### Responsibilities

**Gateway owns:**
- ChatGPT Web login and persistent browser session.
- Browser lifecycle, model discovery, model selection and usage/error reporting.
- Its own authenticated API surface, primarily native Responses + SSE.
- Independent health/status endpoints and safe admin/login UI.
- Its own API key(s), configuration and persistent data.

**CPA optionally owns:**
- Aggregating this Gateway with other providers.
- Central client API keys, model aliases, routing and failover where supported.
- Unified client-facing endpoint, usage/log management and provider selection.

Clients may call the Gateway directly when aggregation is not needed. When CPA is used, the intended flow is `client -> CPA -> Gateway`, with the Gateway remaining independently usable and deployable.

### Do not couple Gateway implementation to CPA internals

- The Gateway must not require CPA OAuth files or CPA to launch.
- Native ChatGPT Web login remains the primary credential mode for using the ChatGPT Web session.
- A CPA Codex OAuth file contains a different credential type (Codex OAuth tokens), not the browser cookies/local storage used by the Web adapter. Importing it must never be described as restoring a ChatGPT Web browser session.
- If optional Codex OAuth support is ever added, it is a separate provider/auth mode and should be labelled separately; it is not the Web-session backend.
- Keep the Gateway API protocol explicit and independently documented. CPA compatibility is an integration test/adapter concern, not a reason to weaken the standalone API contract.

### Standalone API contract

Initial public API target:
- `GET /healthz` — minimal health only, no sensitive account details.
- `GET /v1/models` — authenticated, reports only discovered/supported model identifiers.
- `POST /v1/responses` — authenticated native Responses request, including SSE streaming.
- Optionally later: `POST /v1/chat/completions` as a separate compatibility adapter, with its supported feature set documented.

The admin/login UI uses a separate authentication/session from the model API key. A security-group rule only makes a port reachable; it does not provide authentication or encryption. For public access, require TLS, strong admin authentication, API bearer authentication, origin/CSRF protections, rate limits, and redaction of credentials from logs. Never expose Chrome DevTools/CDP directly.

### Integration principle

First validate the Gateway API independently using local curl/API tests and a generic Responses client. Then configure CPA's Codex-specific upstream to call it and test actual request metadata, streaming, and conversation continuity. CPA support must not be assumed solely because both sides use a `/v1/responses` path.
