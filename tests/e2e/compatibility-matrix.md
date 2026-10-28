# Core / adapter / NEXT 独立升级兼容矩阵

验收日期：2026-10-27

状态：**BLOCKED — 无真实 NEXT 实机证据**。本机仅有官方 DeepSeek Harness 0.2.1-rc.3，不是 Anywhere Labs DSH NEXT 2.0.20-next。adapter 已声明 `dsh.bundle.patch` 安装入口，但尚未在真实 NEXT 中安装或激活。

## 实测基线

| 组件 | 实测版本 | 实机状态 |
| --- | --- | --- |
| Core | 当前工作树构建产物 | 未与真实 NEXT 联机 |
| adapter | 当前工作树构建产物 | 未安装或激活 |
| NEXT | 未安装 | 阻断 |
| DSH | 0.2.1-rc.3（官方 DeepSeek Harness） | 非 NEXT 替代品 |

## 单组件升级矩阵

每次只能变更一个组件，其余版本保持不变。所有单元当前均为 **未验证**，不是通过。

| 场景 | Core 数据 | 已有 Run | NEXT 原生 Session | 预期协议行为 | 实测 |
| --- | --- | --- | --- | --- | --- |
| 仅升级 Core，协议兼容 | 保留 | 保留原状态 | 不受影响 | 重连并对账 | 未验证 |
| 仅升级 Core，协议不兼容 | 保留 | 不批量失败 | 不受影响 | 只停用该 runtime | 未验证 |
| 仅升级 adapter，协议兼容 | 保留 | 恢复原 Run | 不受影响 | 重连并对账 | 未验证 |
| 仅升级 adapter，协议不兼容 | 保留 | 不批量失败 | 不受影响 | 只停用该 runtime | 未验证 |
| 仅升级 NEXT，协议兼容 | 保留 | 恢复原 Run | 可用 | 重连并对账 | 未验证 |
| 仅升级 NEXT，协议不兼容 | 保留 | 不批量失败 | 原生能力不受影响 | 只停用该 runtime | 未验证 |
| adapter 卸载 | 保留 | 不自动改写终态 | 可用 | Runwright runtime 不可用 | 未验证 |
| Core 停止 | 保留 | 断线不等于失败 | 可用 | 不自动重跑 | 未验证 |
| adapter 停止 | 保留 | 断线不等于失败 | 可用 | 不自动重跑 | 未验证 |

## 证据要求

每一轮记录变更前后四组件版本、真实 NEXT 截图、Core/adapter 日志、Run ID、Session ID 和用户消息数。升级不兼容不得导致已有 Run 批量失败，不得产生第二个执行 Session 或重复 Prompt。

真实 NEXT 安装与模型环境就绪前，本矩阵保持未完成；fake NEXT 和官方 DSH 结果只能用于各自测试范围，不能填入本矩阵作为实机通过证据。
