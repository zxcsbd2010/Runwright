# NEXT/macOS 黄金路径验收

验收日期：2026-10-28

状态：**IN PROGRESS — NEXT 已安装并在隔离数据目录中运行，真实 UI 与端到端验收尚未完成**。官方 DeepSeek Harness 与 fake NEXT 集成测试不能替代本记录要求的真实证据。

## 环境预检

| 项目 | 实测结果 |
| --- | --- |
| 官方 DSH | `/Applications/DeepSeek Harness.app`，`com.deepseek.dsh`，0.2.1-rc.3；不是 NEXT |
| NEXT | `/Applications/DSH NEXT.app`，`ai.deepseek.dsh.desktop.next`，2.0.20-next，内置 DSH 0.2.1-rc.3；官方 DMG SHA256 与签名已核验。2026-10-28 已确认主进程、GPU、网络与 renderer 进程持续运行，数据仅写入 `.superpowers/next-e2e/home` |
| NEXT 启动根因 | Qoder shell 继承 `ELECTRON_RUN_AS_NODE=1`，导致 Electron 以 Node 模式在创建数据目录前静默 `exit(0)`；仅对启动命令使用 `env -u ELECTRON_RUN_AS_NODE` 后运行成功，未修改应用或关闭安全机制 |
| 本地 next-runtime 包 | 实际为 `@deepseek-ai/dsh-desktop` 0.2.1-rc.3，不是 NEXT 2.0.20-next |
| adapter 安装入口 | 已声明 `dsh.bundle.patch: ./cordis.patch.yml`，patch 插入 `@runwright/next-adapter`；0.1.0 与 0.1.1 已通过真实 NEXT UI 安装，完整激活仍未验收 |
| 官方 DSH 安装 smoke | 在隔离 `DSH_HOME` 的全新临时 profile 中，官方 DSH 0.2.1-rc.3 已从单个本地 adapter 归档直接安装，无需 contracts 归档或 registry override；adapter 加入 `dsh.profile.bundles`，`--dump-config` 展开 `runwright-next-adapter`。卸载后该层消失，重装后恢复；安装目录内 Host/Client 导出均可由 Node 24 导入。仅验证 DSH 安装契约，不是 NEXT 验收 |
| Core/adapter | Core 0.1.0 正在隔离配置下监听 `127.0.0.1:47832`；adapter 0.1.1 的 Host 曾与 Core 建立已认证连接，但完整重启后客户端服务依赖错误阻断激活。adapter 0.1.2 已通过 110 条包测试和类型检查并完成打包，尚未安装到真实 NEXT |
| 原生权限与模型 | Qoder Computer Use 的辅助功能与屏幕录制授权已完成，可操作真实 NEXT UI；NEXT 原生 Computer Use 保持关闭，模型未配置，原生 picker、审批和端到端流程仍未验证 |

## 安装与激活故障记录

| adapter | 真实 NEXT 结果 | 修复与当前状态 |
| --- | --- | --- |
| 0.1.0 | Host 日志报告 `TYPERT.model must be an object`；Renderer 报告 `Cannot use import statement outside a module` | 补齐 Typert 空模型数组；浏览器客户端改为 CJS 并包装为 NEXT `window.__ModuleLoader__.load` 格式 |
| 0.1.1 | 启用后 Host 曾连接隔离 Core；完整重启进入恢复页：`pending (waiting for services: remote.runwright, directoryPicker)` | 启动依赖改为 `slots`、`sessions`、`remote`、`remote.directoryPicker`；目录选择改走 `remote.directoryPicker.pick()`，移除本插件挂载后才存在的 `remote.runwright` 前置依赖 |
| 0.1.2 | 尚未安装，不能记为激活通过 | 14 个测试文件、110 条测试及类型检查通过；tarball SHA256 为 `32aaa39f4ad09d74d98af08e2b8fc790857212fe45132eae22b07b36ed75d2b4`。真实 NEXT 当前停在 0.1.1 卸载确认警告，等待用户对该第三方警告的动作时确认 |

以上日志仅来自 `.superpowers/next-e2e/` 下的隔离环境，不作为公开审计材料上传。Host/Core 曾连接不等于客户端激活、黄金路径或重启恢复通过。

## 执行记录

以下项目继续保持 **未验证**。NEXT 进程存活只解除启动阻断，不代表 UI、adapter 或端到端验收通过；不得将自动测试、官方 DSH、模拟 UI 或其他版本记为通过。

### 1. 安装、激活与生命周期

- [ ] 记录 Core、adapter、NEXT、DSH 四个实际版本。
- [ ] 通过实际 bundle 安装入口安装并激活 adapter，重启后仍生效。
- [ ] 升级、卸载 adapter，确认边界与数据符合设计。
- [ ] 停止 Core 或 adapter 后，NEXT 原生 Session 仍可使用。

### 2. 需求到代码黄金路径

- [ ] 通过原生目录选择器注册专用测试项目，不手工注入路径。
- [ ] 提交一个小型可测试代码需求。
- [ ] 只创建一个执行 Session，需求只提交一次。
- [ ] 所有审批在 NEXT UI 完成，adapter 不执行外部副作用。
- [ ] Result Session 展示真实文件改动与测试输出，工作台状态和历史正确。
- [ ] 打开 Result Session 使用真实 NEXT 导航。

### 3. 故障恢复

分别在分派后、执行中、审批中、取消响应前重启 Core 和 NEXT。每种场景都需保留 Session ID、消息数、Run 状态和日志证据。

- [ ] 恢复原 Run 和原 Session，不创建替代 Session。
- [ ] 不重复 Prompt，不自动发送“继续”、重跑、取消或回滚。
- [ ] 结果未知的 Run 进入 `attention`，不误报成功。

### 4. 原生 Computer Use

仅在用户明确启用 native provider，并授予 macOS 屏幕录制、辅助功能权限后执行。

- [ ] 通过真实 Session `/computer-use` 解锁。
- [ ] `agent.ctx.tools.schemas()` 包含 `cua_driver_native__*`。
- [ ] 所用模型支持截图；`commandMode=true` 隐藏工具时不得记为通过。
- [ ] 两个桌面任务严格串行。
- [ ] Core/adapter 离线不影响 NEXT 原生 Computer Use。

### 5. 安全边界

- [ ] commit、push、deploy、外部消息只验证阻断与人工审批，不实际执行。
- [ ] 无自动 commit、push、deploy、外部消息、回滚或替代 Session。
- [ ] 密钥、Token、Prompt、环境变量、rootPath 不出现在公开审计或上传材料中。

## Spec 第 19 节逐条追踪

以下状态只记录真实 NEXT/macOS 验收，不使用单元测试、fake NEXT、官方 DSH 或 smoke 结果替代。

| 验收标准 | 对应证据 | 实测状态 |
| --- | --- | --- |
| 1. 注册本地项目并完成需求到代码 | 第 1、2 节；原生 picker、真实模型、文件和测试截图 | 未验证 |
| 2. 单一执行 Session 且不重复需求 | 第 2、3 节；Run ID、Session ID、用户消息数 | 未验证 |
| 3. 状态、历史、审批等待、验证摘要和 Result Session | 第 2 节；工作台与 Result Session 截图 | 未验证 |
| 4. 授权读写和测试，无自动外部副作用 | 第 2、5 节；工具审批与阻断日志 | 未验证 |
| 5. 关键阶段重启后 attach、补事件和对账 | 第 3 节；分派后、执行中、审批中、取消响应前矩阵 | 未验证 |
| 6. 未知结果和异常进入 attention，不续跑或替换 Session | 第 3 节；Run 状态、Session ID 和消息数 | 未验证 |
| 7. 手动重试保留历史，取消不回滚副作用 | 第 2、3 节；新旧 Run 历史及取消前后文件状态 | 未验证 |
| 8. Core/adapter 故障不影响原生 Session 和 Computer Use | 第 1、4 节；离线后的原生操作截图与日志 | 未验证 |
| 9. macOS UI、截图、picker、审批及会话跳转 | 第 2、4 节；真实界面截图与权限状态 | 未验证 |
| 10. loopback、连接凭据和日志隐私 | 第 5 节；监听地址、无凭据拒绝及脱敏日志 | 未验证 |
| 11. 单组件升级及不兼容隔离 | `compatibility-matrix.md`；逐轮四组件版本和运行证据 | 未验证 |

## 解除阻断条件

完成 Qoder Computer Use 的辅助功能与屏幕录制授权，并提供可用模型及专用测试项目后，按本清单逐项执行。启动 NEXT 时必须移除继承的 `ELECTRON_RUN_AS_NODE` 并保留隔离数据目录。每项必须附真实截图和日志；未执行的项目继续标为未验证。
