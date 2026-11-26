# PaperEditer

面向论文写作和知识整理的本地可视化工作台。Local-first visual thesis and knowledge editor.

## 功能

- 可编辑的论文目录树、独立批注与关联网。
- 直接编辑正文、数学公式、图表；使用永久 ID 维护交叉引用。
- 批注可以关联文字、图表对象，也可以独立保留在页面位置。
- 双页阅读编辑、目录和正文折叠、浏览位置记忆。
- 自动保存、对象级并发合并、撤销与重做；批注回收站与交叉引用清理。
- 单文件文档、独立本地 Git 长期历史、命名版本、Diff 和恢复；Agent CLI。

## 快速启动

需要 Python 3.10+、Git、Node.js 22.12+（推荐当前 LTS）、npm，以及现代浏览器。

在项目根目录执行：

~~~sh
cd thesis-workbench
python -m pip install -r requirements.txt
npm ci
python server.py
~~~

浏览器打开 http://127.0.0.1:8191/ 。初次启动不绑定任何项目，不需要私人论文文件。

桌面和手机均可通过顶部「打开文件」输入服务器上的绝对路径（包括 UNC 网络共享路径），打开已有文件或选择「新建文件」在指定路径创建包含各类对象示例的独立 JSON（不覆盖已有文件）。最近打开记录可直接选择或删除，删除记录不删除文件。

详见 [工作台文档](thesis-workbench/README.md) 和 [安全说明](SECURITY.md)。服务默认只监听本机回环地址，不是可直接部署到公网的多用户服务。

## 开发与测试

在 `thesis-workbench/` 目录安装依赖后运行：

~~~sh
python -m unittest test_server test_document
node test_ui.cjs
~~~

浏览器测试需要 Chrome 或 Chromium，具体配置见工作台文档。GitHub Actions 在提交及 PR 时运行回归测试。开发流程、反馈要求和数据隔离规范见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 数据与代码

程序代码位于 thesis-workbench。用户的正文、批注、图片、历史记录和原始绘图文件均为本地私有资料，不属于公开代码；默认 Git 忽略这些内容。正式文档为单个 UTF-8 JSON（v3），直接存储编辑文本和结构，以绝对路径引用外部文件，历史存放在同级独立裸 Git 仓库。旧格式首次打开时自动迁移并保留备份。编辑器记住上次打开的文档，Agent 通过 CLI 或 API 编辑。

项目目前不附带项目级许可证；公开可见不等于授予开源许可。第三方依赖各自的许可条款仍然适用。
