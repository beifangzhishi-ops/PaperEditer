# PaperEditer 工作台

## 安装与运行

Python 3.10+、Node.js 22.12+、npm：

~~~sh
python -m pip install -r requirements.txt
npm ci
python server.py
~~~

打开 http://127.0.0.1:8191/ 。Windows 也可通过 pythonw.exe start.pyw 无控制台启动，日志保存在本目录。

默认首次启动不打开任何文档，通过顶部「打开文件」输入 .json 文件绝对路径。可通过 PAPEREDITER_PORT 指定端口；显式设置 PAPEREDITER_DATA_DIR 可启用旧的独立目录模式（用于测试与迁移）。服务仅监听回环地址，不应直接暴露公网。

## JSON 文本工程索引

.json 是 UTF-8 JSON 文本，包含格式版本、files（逻辑路径到工程相对路径的映射）、objects（对象路径与定位信息），不存储数据库或二进制内容。路径以 .json 所在目录为基准。正文、知识块和批注继续使用 Markdown；公式、表格等对象用所属 Markdown 路径及永久 ID 定位，普通段落用行号定位。图片可直接引用原项目内已有文件。绘图源文件和原始完整 LaTeX 工程独立维护，不自动覆盖。

~~~sh
python workspace.py pack data /path/to/project/thesis.json
python workspace.py list /path/to/project/thesis.json
python workspace.py unpack /path/to/project/thesis.json /path/to/empty-export
python workspace.py refresh /path/to/project/thesis.json
python workspace.py migrate /path/to/old.json /path/to/new.json
~~~

pack 会创建普通文件目录与索引，不覆盖已有文件；migrate 从旧 SQLite 工作区迁出内容，并在图片/参考文献与现有原件字节一致时直接引用。外部修改 Markdown 后可用 refresh 重建对象索引。files 是文件定位的权威映射；objects 是派生索引。保存使用 revision 校验、逐文件原子替换与历史快照；多个普通文件并非一个数据库事务，意外断电时应通过备份或历史恢复。备份时请停止编辑并复制索引及其引用文件。

桌面和手机通过网页顶部「打开文件」输入服务器可访问的 .json 文件绝对路径，例如 `C:\Projects\demo.json` 或 `\\server\share\project\demo.json`（UNC 网络共享，须具备服务器进程的读写权限）。服务不绑定项目目录、不扫描磁盘、不管理文件，直接解析并编辑原件。也可从最近成功打开的记录中选择文件。`PAPEREDITER_WORKSPACE` 可显式指定启动文件。

最近打开、当前工作区及每份文档的阅读位置、导航和页面折叠状态由服务端记录在 `workspace.local.json`（不提交到 Git），所有设备共享。切换前保存当前浏览器的修改；其他客户端须刷新后再编辑。刷新或再次打开文档时恢复共享阅读位置，正在阅读的页面不会实时被其他设备滚动位置打断。文件缺失时提示重新选择。备份时须包含 .json 及其引用的文件。

仓库附带 `example.json` 和 `example-data/`，包含虚构章节、公式、表格及知识块批注。建议先将两者一起复制到仓库之外的同一目录，再输入副本的完整路径打开；编辑会直接保存到引用文件。

## 编辑与存储

- 论文树：data/outline.json 和 data/thesis/。
- 知识块：data/blocks.json 和 data/blocks/。
- 图片：data/assets/。
- 历史快照：data/history/。
- 原始导入片段及标签：data/original/ 和 data/original_labels.json。

正文支持可视化编辑、MathLive 公式、图表、交叉引用、批注及知识块。内部用文本和永久 ID 存储，网页不会自动写回 LaTeX 源文件。备份请复制完整的数据目录。

桌面端右键菜单支持剪切、复制、粘贴。顶部工具栏图标控制底部浮动工具栏的显示与隐藏，手机默认显示，状态记忆在浏览器中。浮动工具栏仅显示图标，按当前光标、选中文字或对象操作，保留撤销、重做，不提供历史浏览入口；触屏长按仍可访问上下文菜单。剪贴板权限不可用时，使用编辑器内剪贴板。删除批注或知识块时移入块网回收站，并清理相关交叉引用；可从回收站恢复。

浮动工具栏首个图标切换查看／编辑模式（默认快捷键 Ctrl+Alt+E，可自定义）。手机每次加载默认查看模式，桌面默认编辑模式。查看模式下正文、章节标题、公式、表格和批注均只读，仍可选中文字、复制、查看引用和批注。切到编辑模式不会立即弹出键盘，点击需要编辑的位置才开始输入；切回查看模式将取消编辑焦点并收起数学键盘。

## 导入现有论文（可选）

~~~sh
python -m pip install -r requirements-import.txt
python import_thesis.py --source "/path/to/latex-project" --data-dir "/path/to/new-data"
~~~

当前导入器适配包含 main.aux、main.pdf、contents/abstract.tex、contents/chapter*.tex 和 refs.bib 的论文结构，不是通用 LaTeX 解析器。导入必须使用新目录，已有数据不会被覆盖。复杂图表、公式和文献引用需要人工复核。

## 测试

~~~sh
python -m unittest test_server
~~~

服务端测试使用临时数据目录，不访问真实论文。仓库中不包含私人数据、原始绘图文件、截图、日志或特定本地环境的验收脚本。

浏览器回归测试：安装 Chrome 或 Chromium，然后执行 `node test_ui.cjs`。Windows 默认使用常见 Chrome 安装路径；其他系统或自定义安装位置请通过环境变量 `PAPEREDITER_CHROME_PATH` 指定浏览器可执行文件路径。测试使用仓库中的虚构示例，模拟保存接口，不改动任何实际工作区。

## 已知限制

顶部全屏图标优先进入浏览器原生全屏；浏览器不支持或拒绝时进入沉浸模式。两种模式均支持正文上滑隐藏完整顶部栏、下滑恢复，鼠标滚轮也可操作；隐藏时右上角保留小型恢复按钮。普通模式不自动隐藏。沉浸模式无法强制隐藏系统或浏览器导航栏。

顶部「安装」按钮会调用支持的浏览器安装提示，其他浏览器显示添加到主屏幕的操作说明。PWA 使用独立窗口（standalone），适配手机刘海和底部安全区，安装能力取决于浏览器及访问地址（通常需 HTTPS 或 localhost）。部分手机 Edge 可能只创建普通网页快捷方式，可尝试 Android Chrome 或 iOS Safari。不缓存论文数据，不提供离线编辑，仍需连接服务器。部署更新后如 manifest 或图标路由尚未生效，需重启服务。

本应用为本地单用户工具，无独立账号认证、多人协作和公网权限隔离。请通过受信任的私有网络使用，详见根目录安全说明。

工程索引按内容识别，旧 `.paper` 文件仍可打开。
