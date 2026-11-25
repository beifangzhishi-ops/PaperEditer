# PaperEditer

面向论文写作和知识整理的本地可视化工作台。Local-first visual thesis and knowledge editor.

## 功能

- 可编辑的论文目录树、独立知识块与关联网。
- 直接编辑正文、数学公式、图表；使用永久 ID 维护交叉引用。
- 批注可以关联文字、图表对象，也可以独立保留在页面位置。
- 双页阅读编辑、目录和正文折叠、浏览位置记忆。
- 自动保存、冲突检测、撤销与重做；知识块回收站与交叉引用清理。

## 快速启动

需要 Python 3.10+、Node.js 22.12+（推荐当前 LTS）、npm，以及现代浏览器。

在项目根目录执行：

~~~sh
cd thesis-workbench
python -m pip install -r requirements.txt
npm ci
python server.py
~~~

浏览器打开 http://127.0.0.1:8191/ 。初次启动不绑定任何项目，不需要私人论文文件。

桌面和手机均可通过顶部「打开文件」输入服务器上的绝对路径（包括 UNC 网络共享路径），或选择共享的最近打开记录。可输入仓库附带的 `thesis-workbench/example.paper` 的完整绝对路径打开虚构示例；如要保留干净的示例，请将 example.paper 和 example-data/ 一起复制到其他目录。

详见 [工作台文档](thesis-workbench/README.md) 和 [安全说明](SECURITY.md)。服务默认只监听本机回环地址，不是可直接部署到公网的多用户服务。

## 开发与测试

在 `thesis-workbench/` 目录安装依赖后运行：

~~~sh
python -m unittest test_server
node test_ui.cjs
~~~

浏览器测试需要 Chrome 或 Chromium，具体配置见工作台文档。GitHub Actions 在提交及 PR 时运行回归测试。开发流程、反馈要求和数据隔离规范见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 数据与代码

程序代码位于 thesis-workbench。用户的正文、知识块、图片、历史记录和原始绘图文件均为本地私有资料，不属于公开代码；默认 Git 忽略这些内容。可将 .paper（UTF-8 JSON）工程索引保存在其他项目中，直接通过相对路径引用普通文件，从编辑器的「打开文件」入口直接打开。编辑器会记住上次打开的文件。

项目目前不附带项目级许可证；公开可见不等于授予开源许可。第三方依赖各自的许可条款仍然适用。
