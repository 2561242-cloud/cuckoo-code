---
name: 项目更新
description: 把本项目的自定义功能（技能管理/技能市场/网页技能栏）合并到 Cuckoo Code 主仓库最新版。当用户说"更新项目""合并主仓库最新代码""把我的功能合到新版"时使用。
when_to_use: 用户想拉取 Cuckoo Code 主仓库最新代码，并把本地自定义功能（提交 997fc71：技能管理+技能市场+网页技能折叠栏）重新合并上去时。
---

# 项目更新（合并主仓库最新代码 + 本地功能）

## 背景

本项目 `cuckoo-code-repo` 是对 Cuckoo Code 的二次开发：

- **上游主仓库**：`origin` = https://github.com/wangyongpeng90/cuckoo-code（只读，无推送权限）
- **本地 fork**：`fork` = https://github.com/2561242-cloud/cuckoo-code
- **本地功能提交**：`997fc71` — feat(skills): 技能管理 + 技能市场 + 网页内技能折叠栏（在 `feat/skills-market` 分支）

本技能的目标：**拉取主仓库最新代码，把本地功能提交重新合上去**。

## 目录

工作目录：`G:\工程文件夹\cuckoo源码\cuckoo-code-repo`

## 执行流程

### 第 1 步：确认工作区干净

```bash
git status --short
```

- 若有**未提交的改动**，先停下，询问用户如何处理（提交/暂存/放弃），不要贸然覆盖。
- 输出为唯一允许的 `?? ex2/`（用户自己的目录）可忽略。

### 第 2 步：拉取主仓库最新

```bash
git fetch origin --prune
git log --oneline origin/master -1
```

记下 `origin/master` 最新提交。

### 第 3 步：基于主仓库最新重建合并分支

固定分支名 `merge-skills-market`：

```bash
git checkout -B merge-skills-market origin/master
```

### 第 4 步：合入本地功能提交

```bash
git cherry-pick 997fc71
```

**判断结果：**

- **成功** → 跳到第 5 步。
- **冲突** → 执行 `git status` 查看冲突文件，然后**停下**：
  1. 向用户说明哪些文件冲突
  2. 给出冲突分析（两边各改了什么）
  3. 给出建议方案，**等用户确认后**再解决（`git add` + `git cherry-pick --continue`）
  4. **不要**未经确认就盲目 `--skip` 或乱改代码

  > 注意：cherry-pick 的提交号 `997fc71` 是固定的。若该提交在 fork 上有更新，可改用：
  > `git cherry-pick $(git rev-parse fork/feat/skills-market)`

### 第 5 步：验证

```bash
git log --oneline -5
npm test -- test/skills 2>&1
```

- 测试通过 → 完成
- 测试失败 → 分析原因，告知用户

### 第 6 步：报告结果

向用户报告：
- 主仓库最新版本（版本号/tag）
- 合并后的分支名
- 测试结果
- 下一步建议（如需打包：`npm run compile && npx electron-builder --win dir --publish never`）

## 注意事项

- 工作目录含中文，shell 命令输出可能乱码；读取文件用 `read` 工具，验证结果可用 `node -e` 输出到文件再读。
- `package-lock.json` 可能被 `npx` 意外改动，提交前用 `git checkout -- package-lock.json` 还原。
- `src/providers/generated/hook-sources.ts` 是生成的无关文件，若被 `build-hooks` 刷新，用 `git checkout --` 还原。
- 打包很慢且依赖网络下载 electron，非必要不打包。
