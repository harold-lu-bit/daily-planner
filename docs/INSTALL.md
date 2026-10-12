# 从仓库部署到 Obsidian Vault

适用于 Research Planner 0.3.2。仓库名是 `daily-planner`，插件 ID 和安装目录名仍为 **`research-planner`**。不需要原 Windows 工作空间、迁移压缩包、WSL、Python 后台服务或其他 Obsidian 社区插件。部署请求授权安装；日程写入仍由用户在面板接受草稿。

## 给 Agent 的部署任务

可以直接使用下面的指令，通过受保护的凭据输入方式另外提供 API key：

> 请按此仓库 AGENTS.md 和 docs/INSTALL.md，将 Research Planner 部署到我的 Obsidian Vault。沿用 examples/plugin-settings.example.json 的服务商地址，model-name 为 `<模型名称>`，API key 另行安全提供。请识别目标 Vault；有多个候选时让我指定。保留现有日记、模板和同步设置，完成构建、安装与配置，密钥放进 Obsidian SecretStorage。验证插件加载和合成连接测试，不生成或接受真实日程。报告安装版本、备份位置及尚需我操作的步骤。

最少需要：仓库访问权限、目标设备/Vault 的访问权限、API key、准确的 model name。只有一个可明确识别的 Vault 时，Agent 可以自行读取其路径与日记设置；多个 Vault 时需要用户指定。

仓库已包含原服务商的不含密钥的地址示例 `https://llm.inner.bza.edu.cn/plan/v1`。**沿用这个服务商时无需重复提供地址；更换服务商必须提供 API base URL。** 不要根据 key 的形状或 model name 猜地址。目标机器必须能访问所选服务商；仓库访问权限不代表 API 网络权限。

## 1. 获取并构建

需要 Git、Node.js 22（原生 Windows / macOS / Linux 均可）与随附的 npm。Obsidian 最低版本以 `manifest.json` 为准，目前是 1.13.0，需要 SecretStorage 支持。安装后运行插件不需要 Node.js。

在 Vault 外的开发目录执行：

```sh
git clone https://github.com/harold-lu-bit/daily-planner.git
cd daily-planner
npm ci
npm test
npm run build
```

私有仓库先通过 GitHub CLI 或 Git 凭据管理器登录；不要把 GitHub token 嵌入 clone URL。在 PowerShell 中若 `npm.ps1` 被执行策略阻止，改用 `npm.cmd`，无需修改系统策略。

`npm ci` 使用锁文件安装全部构建依赖。源码仓库不提交 `node_modules` 或 `main.js`；构建会在仓库根生成 `main.js`。安装所需文件只有 `main.js`、`manifest.json`、`styles.css`。

需要 ZIP 时：Windows 运行 `npm.cmd run package:windows`；macOS/Linux 安装 Python 3 后运行 `npm run package`。输出在 `dist/`，包含插件、说明、配置/模板示例与依赖许可证。构建安装本身无需打 ZIP。

## 2. 识别 Vault、备份并安装

1. 在 Obsidian 或其 Vault 列表中确认实际路径。默认配置目录为 `.obsidian`，若用户指定了不同的配置目录，应使用该目录。不要拿仓库目录当 Vault，不要扫描全部笔记寻找目标。
2. 检查当前插件的 manifest、Daily Notes 设置及模板路径。如果插件已安装，先关闭 Research Planner 或退出 Obsidian，避免运行中的旧代码与新文件混用。
3. 将已存在的 `main.js`、`manifest.json`、`styles.css` 备份到 Vault 外带时间戳的目录。若要调整配置，另备份将改的具体配置；不要复制整个 `.obsidian`，不要把备份放进 Git。
4. 将三个发布文件复制到 `<Vault>/<配置目录>/plugins/research-planner/`，缺少目录则创建。保留现有 `data.json`、其他插件、主题和 LiveSync 配置。不要将整个仓库复制进去。
5. 比较源与目标三个文件的 SHA-256，确认 manifest 的 ID 为 `research-planner`、版本为 0.3.2。Windows 可用 `Get-FileHash -Algorithm SHA256`，Linux 用 `sha256sum`，macOS 用 `shasum -a 256`。
6. 在 Obsidian 社区插件设置中允许社区插件并启用 Research Planner。升级时重新启用或重启应用。磁盘文件一致只证明安装成功，仍需确认应用实际加载成功。

若复制中途失败，恢复本次已替换的发布文件；如果期间出现人工修改，则先核对，不覆盖新编辑。不要为了安装而删除已有插件数据或重建同步数据库。

## 3. 日记与模板

读取现有内置 **Daily Notes（日记）** 设置，优先沿用。默认配置目录下是 `daily-notes.json`。插件不要求 Outliner、Tasks、Templater、Bases 或其他社区插件。

如果是新 Vault，可使用这套完整配置；已经配置过则按字段保留或合并，不整文件覆盖：

```json
{
  "folder": "10 Daily",
  "format": "YYYY/MM/YYYY-MM-DD",
  "template": "99 System/Templates/Daily"
}
```

创建日记根目录 `10 Daily`，将仓库 `examples/Daily.md` 放入 `99 System/Templates/Daily.md`，并启用内置 Daily Notes。模板设置通常不写 `.md` 后缀。旧模板含有 `## Tasks` 时无需替换；如果使用其他二级标题，在插件“任务章节名称”中填写对应文字（不含 `##`）。

支持的模板变量是 `{{date}}`、`{{date:日期格式}}`、`{{title}}`；Templater 脚本和其他未识别变量不会执行。示例模板没有私有 Bases 链接或插件注释。不要在部署时新建当天日记、迁移历史任务或清理笔记标记，除非用户另外要求。

## 4. 模型、密钥及写入开关

插件设置中填写：

| 项目 | 设置 |
| --- | --- |
| API 基础地址 | 所用服务商的 base URL，不含 `/chat/completions`；示例地址见上文 |
| 模型 ID | 用户提供的准确 model name |
| JSON 响应模式 | 默认 `json_object`；服务商明确不支持时可选“仅提示词约束” |
| API 密钥 | 通过 Obsidian SecretStorage 添加/选择本机秘密 |
| 任务章节名称 | 默认 `Tasks`，对应日记二级标题 |
| 时区 | 默认 `Asia/Shanghai`；多设备保持一致 |
| 允许本设备写入 | 部署目标包含正常使用时，在插件设置中开启 |

接口使用兼容 Chat Completions 的请求：`POST <baseUrl>/chat/completions`、Bearer key、`messages`、`max_tokens`，默认附加 `response_format: {type: "json_object"}`。服务商需要支持这些字段与 JSON 文本响应。本指南描述插件实际协议，不表示所有模型均兼容。

`examples/plugin-settings.example.json` 只包含非秘密配置。首次安装时，可替换其中的 model 占位符后保存到插件目录 `data.json`；已有 `data.json` 只合并用户要求的字段，保留其他值。`secretName` 是秘密的名称/引用，**不是 API key**。

API key 必须通过 Obsidian SecretStorage 配置，不能放入 `data.json`、模板、仓库 `.env` 文件、安装脚本、命令行参数或 Git。Agent 有可用的安全 UI 控制时可以完成；没有时，应先完成全部其他步骤，再明确请用户在“设置 → Research Planner → API 密钥”中添加/选择秘密。不要把“写入 secretName”误报为密钥已配置。

“允许本设备写入”、调用计数、提醒与恢复记录在 Obsidian 本机存储中，不在 `data.json`；不要通过复制另一台设备存储来开启。每台设备都需设置密钥和写入开关。

若 Vault 已有 `99 System/Automation/Research Workflow Config.md`，检查 YAML 中 `planner.enabled`。明确为 `false` 时会禁止写入，用户要求可用部署时可以在保留其他字段的前提下改为 `true`。不存在则无需为了部署创建；插件默认允许中央层面的写入。修改后重新读取草稿。

跨日任务文件 `99 System/Automation/Research Planner Future.md` 由插件接受草稿时维护，不需要预先创建，也不要用空示例覆盖旧队列。

## 5. 验收及交接

- 打开“日记复盘”面板，确认没有加载错误，能看到今天/明天选项以及默认的“最近一份 TODO”来源设置。只打开面板不会读取任务或调用模型。
- 在插件设置中点击“测试连接”：仅发送合成 JSON，不发送 Vault 笔记，但会使用少量 API 额度。用户仅要求离线安装时跳过并注明。报告 HTTP 错误码或兼容性问题，不输出密钥或服务端原始错误正文。
- 检查 Daily Notes 指向的模板确实存在且变量受支持，以及本机写入开关和可选中央开关。不要以验证安装为由点击“接受并写入”。
- 向用户报告仓库提交、磁盘插件版本、实际加载是否观察到、Vault/安装目录、备份位置、连接测试结果、待完成的本机步骤。用户之后手动生成第一份草稿并确认任务去向。

常见问题：

| 现象 | 检查 |
| --- | --- |
| 找不到插件 | 目录必须是 `plugins/research-planner`，三个文件直接放在该层；检查社区插件开关并重载 |
| 缺少密钥 | SecretStorage 中有实际值，且插件选择了同名秘密；仅复制 data.json 不会迁移密钥 |
| 连接失败或 HTTP 401/403/404 | 网络、key 权限、model name、base URL；不要重复附加 `/chat/completions` |
| JSON 模式不兼容 | 核对服务商能力，必要时切换“仅提示词约束”后再测 |
| 模板不存在/变量不支持 | 检查 Daily Notes 路径和模板正文；不支持执行 Templater |
| “接受并写入”灰色 | 待确认问题、时段冲突、未提交的意见、本机写入开关或正在请求；阅读面板提示 |
| 配置改后仍不能写入 | 中央 `planner.enabled`，以及是否点击“重新读取并复盘” |

## 升级、同步和回退

升级沿用同样的三文件备份/替换流程；不要重置 API 设置、日记模板或本机数据。0.3.2 的队列增加 wasChecklist 清单边界记录（仍为 version 2），0.3.1 及更早版本不能读取新字段；所有操作同一 Vault 的设备需要兼容版本，不能假设密钥与本机开关随 Markdown 同步。

仅替换发布文件、尚未接受新草稿时，可以恢复刚备份的发布文件。已经接受新草稿后，不要只回退插件而留下旧版不能读取的队列；先用当前版本的“恢复 / 撤销”或成套笔记/队列备份处理状态兼容性。存在后续人工修改时须先核对，不强行覆盖。插件不保证两台设备离线同时编辑时的分布式原子性。
