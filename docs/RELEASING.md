# 发布与跨设备版本维护

本仓库采用 **GitHub Releases 发布，BRAT 安装和更新**。仓库现为公开仓库：`harold-lu-bit/daily-planner`；插件 ID 始终是 `research-planner`。使用插件的设备不需要 Git、Node.js、Python 或开发工作空间。设备安装步骤见 [INSTALL.md](INSTALL.md)。

## 三种状态不要混淆

1. `git push` 只更新源码，不会使 BRAT 获得新版。
2. 推送与 manifest 版本完全相同的 tag（例如 `0.3.2`，不加 `v`）触发 `.github/workflows/release.yml`：锁定依赖安装、测试、类型检查、构建、上传完整资产后公开 Release。
3. 每台设备由 BRAT 检查、下载并加载新版。是否自动检查取决于该设备 BRAT 设置；应用关闭时不会在后台安装。

Release 必须有独立的 `main.js`、`manifest.json`、`styles.css` 附件，不能只有 GitHub 自动生成的 Source code ZIP。另附 `SHA256SUMS.txt` 与 `THIRD-PARTY-LICENSES.txt`。源码不提交生成的 main.js，发布文件不得包含 API key、data.json、真实笔记或备份。

## 给维护 Agent 的任务

> 按 AGENTS.md、docs/RELEASING.md 发布已确认的修改。核对 Git 工作区、当前分支和 origin，不覆盖用户修改。更新版本与 CHANGELOG，执行测试和发布构建，提交并推送源码，再推送对应 tag。等待 Release 工作流完成，下载独立附件并核验版本、提交和 SHA-256。不要覆盖旧 Release，不修改 Vault 或调用真实模型，除非另有部署授权。报告提交、tag、Release 链接与验证结果。

这段任务适用于原生 Windows、macOS 和 Linux。使用 Node.js 22；PowerShell 若拦截 npm.ps1，请用 npm.cmd。GitHub CLI 的登录交互由用户完成；不把 token 写进 URL、脚本、日志或提交。

## 发布步骤

对于已获真实 Vault 测试授权的规划修复，先备份并加载未发布候选构建，使用既有模型生成预览；对照来源人工检查任务完整性、日期含义、多日安排、完成状态、层级及最终 Markdown，再验证一次针对指定条目的自然语言调整。调整测试应在独立会话副本中进行，不能污染用户实际草稿。日记、队列和配置在验收前后核验未变，所有请求证据留在本机忽略目录。出现新的问题时继续修复验证，确认候选可用后才提交、推送和发布。没有真实数据/模型授权时只做合成验证并明确限制，不擅自调用。

1. 读取需求与验证记录，检查 `git status`、当前分支、remote；获取远程状态，保留既有修改。需要 GitHub 对本仓库的推送权限；首次增加 Actions 文件还可能需要相应工作流权限。
2. 修改代码时递增版本；同时更新 `manifest.json`、`package.json`、`package-lock.json` 顶层及 `packages[""].version`。例如下一次修复可用 `0.3.3`。把用户可见变化、兼容性与验证写入 CHANGELOG 对应的 `## 版本 — 日期` 节。纯文档提交不必发布一个新插件版本。
3. 在仓库根运行：

   ```sh
   npm ci
   npm test
   npm run release:prepare
   ```

   `release:prepare` 包含类型检查和构建，校验插件 ID、四处版本与变更说明，从白名单生成 `dist/release/`。无需 Python。设置 `RELEASE_TAG` 时还会验证 tag；工作流自动设置它。不要通配上传整个 dist 或工作目录。

4. 检查差异，提交并推送 main。不要自动包含无关修改，不编造 Git 作者。以下发布命令以首次 `0.3.2` 为例，后续须替换版本：

   ```sh
   git push origin main
   git tag -a 0.3.2 -m "Release 0.3.2"
   git push origin 0.3.2
   gh run list --workflow release.yml --limit 5
   ```

   创建 tag 前核对本地/远程同名 tag 及 Release 均不存在，且 HEAD 是准备发布的已推送提交。正常发布只用三个数字段，Release 名称、tag、manifest version 一致。不要移动已发布 tag。

5. 等工作流成功后查看并下载 Release 验证：

   ```sh
   gh release view 0.3.2 --repo harold-lu-bit/daily-planner
   gh release download 0.3.2 --repo harold-lu-bit/daily-planner --dir .test-runtime/release-check-0.3.2
   ```

   使用新的空目录。检查三文件齐全、manifest id/version、附件校验和、tag 对应提交，并比较本地构建的 main.js。Linux 可在下载目录运行 `sha256sum -c SHA256SUMS.txt`；macOS 用 `shasum -a 256 -c SHA256SUMS.txt`；Windows 用 `Get-FileHash -Algorithm SHA256` 逐项比较。SHA 校验用于确认文件一致性，不能代替对源码和发布账号的信任。

工作流只在发布 job 使用仓库自动提供的短期 GITHUB_TOKEN 写 Release，不需要添加长期 PAT 或模型 API key。先上传 draft 再公开，防止 BRAT 看到缺文件的版本。如果失败留下 draft，先检查 tag 和上传文件；核验完整后再公开，或由维护者修复未公开的 draft。已公开版本发现问题，应发递增的新版本，不覆盖附件。

## Actions 不可用时的手工发布

先完成同样的测试、构建、提交和 tag 推送。确认 Actions 没有同时发布相同版本，且 Release 不存在，再在仓库根执行（PowerShell/macOS/Linux 均可）：

```sh
gh release create 0.3.2 dist/release/main.js dist/release/manifest.json dist/release/styles.css dist/release/SHA256SUMS.txt dist/release/THIRD-PARTY-LICENSES.txt --verify-tag --draft --title 0.3.2 --notes-file dist/release-notes.md
gh release edit 0.3.2 --draft=false --latest
```

公开前核验 draft 所有附件。手工发布与工作流是替代方式，不要对同一版本同时执行，也不要使用 `--clobber` 覆盖已发布资产。

## 设备更新策略与兼容性

- 日常使用 BRAT 的 latest 跟踪发布版；想等某台设备验证后再统一升级，可在 BRAT 固定指定版本，再逐台改为新版本。
- BRAT 的 latest 可能包含较新的 prerelease，不等于 GitHub 的“Latest 稳定版”标记。本仓库默认只发布正常版本；未来若使用测试版，应明确通知并让主力设备固定稳定版本。
- 本项目尚未进入 Obsidian 官方社区插件目录，不能依赖 Obsidian 自带“检查更新”管理它；用 BRAT 更新。未来申请社区收录是另一个任务。
- 0.3.2 的跨日队列含 `wasChecklist`，0.3.1 不能读取；操作同一 Vault 的设备应先全部升级兼容版本。升级后先等笔记同步完成，再从一台设备规划。
- BRAT 管理程序文件，LiveSync 管理哪些内容由用户原有配置决定。检查是否有第二个机制在同步同一插件文件；不要为了安装重置 LiveSync 或擅自改同步规则。秘密与本机写入开关必须逐设备核验。
- 回退时同时考虑状态格式，按 INSTALL.md 的回退说明处理。仅将 BRAT 固定旧版本并不能把队列格式安全降级。

依据：[BRAT 开发者指南](https://github.com/TfTHacker/obsidian42-brat/blob/main/BRAT-DEVELOPER-GUIDE.md)、[私有仓库访问说明](https://tfthacker.com/brat-private-repo)。本机验证结果记录在 VALIDATION.md；支持移动端加载不等于已完成 Android/iOS 实机验收。
