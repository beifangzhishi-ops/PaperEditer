# 参与开发

PaperEditer 的 Git 仓库仅维护编辑器本身及虚构示例，不管理实际论文工程。

## 开发流程

1. 参考 [安装说明](README.md) 安装依赖，在独立分支开发，每次提交保持范围单一。
2. 使用 `thesis-workbench/example.paper` 的副本及对应 `example-data/` 复现问题，不使用真实论文作为测试夹具。
3. 在 `thesis-workbench/` 中运行 `python -m unittest test_server` 和 `node test_ui.cjs`。浏览器路径可通过 `PAPEREDITER_CHROME_PATH` 指定；在非 Windows 系统上请指定已安装浏览器的可执行文件路径。
4. 提交前检查 `git diff --cached`、`git status --short`，确认修改与测试数据可以公开。新增源码或测试夹具时，按需更新 `.gitignore` 中的精确白名单，不要强制添加被忽略的文件。

## 问题反馈

提供操作系统、浏览器版本、复现步骤、预期结果和实际结果。请先用虚构数据复现，移除截图、日志中的真实论文内容、个人路径、网络地址、凭据和阅读记录。安全问题请参阅 [SECURITY.md](SECURITY.md)。

## 仓库范围

不提交用户 `.paper` 文件、正文、原图、备份、运行时配置、缓存、日志、依赖安装目录或本地部署脚本。新增公开示例必须完全虚构。仓库未附带项目级许可证。
