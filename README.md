# FingerMemory CLI

键盘优先的英语学习命令行工具。当前版本同时支持：

- 独立本地模式：词库、会话、正式复习、退出恢复和 Web 兼容的 v5 JSON。
- 账号模式：个人访问令牌、在线会话、拼写/闪卡评分和文字卡牌检查点。
- 非交互终端：无提示符的行式输出、stdin 命令与 `--json` 结果。
- 数据互通：本地 v3/v4/v5 快照导入导出，以及账号完整备份预览/恢复。

旧版 `node app.js`、`config.js` 和 `src/` 保留用于历史查阅，不再是新功能入口。
新命令从 `cli/main.mjs` 启动。

## 环境

需要 Node.js 24.19 或更新的版本。安装依赖：

```sh
npm ci
node cli/main.mjs --help
```

可以执行 `npm link` 后使用 `fm`，或始终通过 `node cli/main.mjs` 运行。

## 本地模式

配置根目录默认为 `~/.finger-memory`。本地和账号 profile 在不同目录中保存，
切换账号不会覆盖本地词库或会话。

```sh
fm lexicon import words.tsv --name "日常英语"
fm lexicon list
fm learn --learning-mode keyboard-recall
fm learn --resume
fm data status
fm data export --output finger-memory-v5.json
fm data import finger-memory-v5.json --yes
```

本地快照与 Web 的本地数据库兼容：

- `snapshotVersion: 1`
- v3/v4 导入后升级为 `schemaVersion: 5`、`dataFormatVersion: 5`
- 正式复习使用固定 `ts-fsrs@6.0.0`、FSRS-7 和与 Web 相同的会话结构
- 导入先完整解析、校验版本和跨表引用；失败不覆盖当前状态

本地状态文件权限为 `0600`，目录权限为 `0700`。退出、EOF 或 `pause` 会原子保存暂停
检查点。

## 账号模式

账号令牌通过隐藏输入创建或保存，不接受命令行明文参数：

```sh
fm --mode account auth login
fm --mode account auth status
fm --mode account auth set-token
```

`auth login` 只在当前进程使用用户名/密码建立 Cookie 会话，随后创建 90 天 PAT，
保存到 profile 的 `token` 文件；密码不会落盘。也可以在 Web 账号页创建或撤销令牌，
再通过 `auth set-token` 保存。

也可以由受控环境注入：

```sh
FINGER_MEMORY_SERVER=http://127.0.0.1:8080/api/v1 \
FINGER_MEMORY_TOKEN='fm_pat_...' \
fm --mode account auth status
```

令牌不会进入日志、命令参数或导出文件。服务端只保存 SHA-256 摘要；PAT 不能执行
Web 令牌管理、GM 管理或借用浏览器管理员 Cookie。

## 在线学习

```sh
fm --mode account lexicon list
fm --mode account lexicon import words.tsv --name "在线词库"
fm --mode account learn --learning-mode keyboard-recall
fm --mode account learn --resume
```

拼写模式直接输入英文答案；`hint`、`reveal` 后输入 `done` 只完成练习，不写正式复习。
闪卡模式使用 `flip`，明确没想起时输入 `again`，之后按真实状态选择：

```text
1 Again    2 Hard    3 Good    4 Easy
```

网络重试继续使用同一个提交 ID；版本冲突会要求刷新或恢复最新服务端会话。

## 文字卡牌

```sh
fm --mode account battle list
fm --mode account battle --resume
fm --mode account battle --battle BATTLE_ID
fm --mode account battle \
  --session SESSION_ID \
  --study-item STUDY_ITEM_ID \
  --encounter cli-training \
  --companion lia
```

终端按编号列出手牌、能量、敌方生命/格挡/灼烧和本回合意图：

```text
play 1         打出第一张牌
play 2 1       第二张牌攻击一号敌人
skill          使用本场唯一伙伴技能
end            结束回合并绑定下一学习任务
status         重印当前检查点
pause          退出，状态保留在服务端
```

学习授能、出牌、伙伴技能与结束回合都有稳定幂等键和版本检查。Web 账号页会列出同一
服务端上的活动文字卡牌并允许继续。

## 非 TTY

stdin 是管道时，CLI 不输出提示符，只输出稳定的 `EVENT key=value` 行。示例：

```sh
printf 'bridge\n3\npause\n' |
  fm --mode account learn --session SESSION_ID
```

脚本化和检查结果可加 `--json`。账号与本地 profile 可通过 `--profile` 分开。

## 验证

```sh
npm run check
npm test
```

测试使用临时目录、假词条和本机开发服务，不读取真实账号、生产 secrets 或用户数据。
