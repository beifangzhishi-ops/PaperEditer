# PaperEditer 工作台

## 安装与运行

Python 3.10+、Node.js 22.12+、npm：

~~~sh
python -m pip install -r requirements.txt
npm ci
python server.py
~~~

打开 http://127.0.0.1:8191/ 。Windows 也可通过 pythonw.exe start.pyw 无控制台启动，日志保存在本目录。

默认首次启动不打开任何文档，通过顶部「打开文件」输入 .json 文件绝对路径，打开已有文档或新建包含各类对象示例的文件。可通过 PAPEREDITER_PORT 指定端口；显式设置 PAPEREDITER_DATA_DIR 可启用旧的独立目录模式（用于测试与迁移）。服务仅监听回环地址，不应直接暴露公网。

快捷键设置由服务端保存在本地配置 `workspace.local.json`，同一服务的所有设备和文档共享，不进入论文文件或 Git。已打开的网页会自动同步，旧浏览器的自定义配置仅在服务端尚无配置时迁移一次；同时修改时拒绝过期配置，重新打开设置后即可编辑。

桌面布局支持拖动导航栏右边界和双页之间的分割线，双击分割线恢复默认宽度；宽度保存在当前浏览器。手机保持单页切换与抽屉导航。章节正文旁的视窗行号由当前渲染的文字行与对象临时计算，各章节从 1 开始，切换页面或调整宽度后重新计算，不进入文档。历史差异按历史版本到当前版本显示，绿色为新增，红色为删除；差异行号使用当前版本正文的行号，删除内容以短横线标记，差异页换行与正文不同时可合并显示对应的行号范围。

## 单文件文档（v3）

桌面鼠标拖选、Shift 延伸选区和手机长按拖动选区支持跨段落与整公式、图片、表格、批注。文本标签与选中对象的绑定批注随选区复制、剪切和删除；当前页面上处于选区纵向范围内的自由放置批注也随之选中。批量复制生成独立批注 ID，剪切粘贴移动原 ID；绑定对象的批注随对象保留绑定，自由放置批注批量粘贴为正文内标签。删除批注进入回收站，撤销恢复整个选区。

新格式将全部可编辑文本、结构和回收站内联在一个 UTF-8 JSON 内，带永久文档 UUID。原 v2 多文件索引在打开时自动迁移：保留原 manifest 的字节备份和旧数据目录，将旧历史导入独立的 `<文档名>.history.git` 裸仓库，校验后才替换入口。旧工具仍可用于 v2/SQLite 导入，不用于 v3 的直接编辑。

图片和原始资源记录绝对路径（服务端视角，包括 UNC），不嵌入二进制；上传目录可用 CLI `upload-directory` 操作指定，默认文档同级的 `<文档名>-assets`。外部资源不改变权限。移动资源可用 `repath` 批量替换绝对路径前缀。移动文档时要将其独立历史仓库一起移动，UUID 不变。备份当前 JSON、历史仓库及必要外部资源。锁文件不存业务数据。Windows 只读属性用于防误操作，不是账户级安全隔离；跨进程锁协调 CLI 和服务，外部绕过权限的修改由扫描检测，非法内容不会被静默覆盖。

批注及其内部图、公式、表不参与论文编号或 TeX 交叉引用索引。正式章节、公式、图、子图、表等仍可交叉引用。批注一览取代原关联图；每条批注最多一个正文位置（文字、对象或自由放置）。编辑模式下单击标签选中，再次点击打开；浮窗顶部或边框可选中整条批注，点击正文则编辑内容。复制粘贴创建新 ID，剪切粘贴移动原 ID，Delete 删除整条批注并移入回收站。剪切后暂未粘贴的批注保留在一览中为未放置状态。旧多位置批注在打开时拆为独立批注，原始版本留在文档 Git 历史；旧交叉引用保留兼容显示但不可新建指向批注的引用。复制图片到正文时创建正式图对象（复用资源路径），复制到批注时保持内部对象语义。旧批注中的本地 Markdown 图片在编辑时转换成内部图对象，打开而未修改不会改写文件。

需要系统安装 Git。每次有效修改生成一个 Git Commit，不产生空提交；服务每约两秒扫描活动文档和已登记图片，补记外部变化，定期压缩历史。Git 仓库没有远程地址。图片只保存路径和指纹，不恢复历史二进制。网页保存和 Ctrl+S 立即给当前提交添加时间名称（Tag），不弹窗；历史默认折叠连续自动版本，支持右键命名/清除、差异和恢复。普通段落通过文本匹配维护 ID，重复文本、复杂重排等无法唯一判断的修改可能产生新 ID。

### CLI

首次安装在本目录执行 `python install_cli.py`。Windows 默认在当前 Python 的 Scripts 目录安装原生 `paperedit.exe`（需要 pip 自带的 distlib 或独立 distlib），Linux/macOS 默认为 `~/.local/bin`；如未在 PATH 中，按提示添加即可。安装后在任意目录执行 `paperedit`（无参显示帮助），命令自动使用原代码仓库的最新版本；相对批量文件路径仍相对于调用者当前目录。Python 可直接用 `subprocess.run(["paperedit", "status"], capture_output=True, check=True)`，无需 shell。默认操作当前文档；指定绝对路径 `--workspace` 不切换网页。服务关闭可用 `--offline`。仅本机连接被拒绝时允许自动回退到本地核心；远程 API 失败、超时、服务器内部错误不会静默回退。所有日常命令输出 JSON，Windows 管道输出使用兼容旧 PowerShell 的 ASCII 转义（JSON 解码后仍为原始 Unicode）。`edit --file -` 支持 UTF-8 JSON 字节输入；文件输入支持 UTF-8 和 UTF-8 BOM。

~~~sh
paperedit new [ABSOLUTE_PATH]
paperedit forget ABSOLUTE_PATH
paperedit status
paperedit list --space thesis
paperedit search "关键词"
paperedit read OBJECT_ID
paperedit edit --file changes.json -m "修改说明"
paperedit history OBJECT_ID
paperedit diff COMMIT --object OBJECT_ID
paperedit tag --name "初稿"
paperedit restore COMMIT --revision REVISION
~~~

批量编辑文件示例：

~~~json
{
  "revision": "read/status 返回的 revision",
  "operations": [
    {"op": "update", "id": "demo-start", "body": "修改后的正文"},
    {"op": "create", "space": "blocks", "id": "note-new", "title": "笔记", "body": "内容"},
    {"op": "bind", "id": "note-new", "target": "demo-start"}
  ]
}
~~~

支持 `update`、`create`、`move`、`delete`、`bind`、`resource`（name、path、type=image/source）、`upload-directory`（path）、`repath`（old、new）等操作。过期 revision 自动合并不重叠修改，冲突返回 409 和差异，不覆盖数据。损坏或缺失的 v3 文档可用 `paperedit --workspace ABSOLUTE_PATH recover [--version COMMIT]` 显式恢复，保留损坏原件；恢复正常文档请使用 restore。

## 旧 v2 JSON 工程索引（迁移兼容）

.json 是 UTF-8 JSON 文本，包含格式版本、files（逻辑路径到工程相对路径的映射）、objects（对象路径与定位信息），不存储数据库或二进制内容。路径以 .json 所在目录为基准。正文、批注和批注继续使用 Markdown；公式、表格等对象用所属 Markdown 路径及永久 ID 定位，普通段落用行号定位。图片可直接引用原项目内已有文件。绘图源文件和原始完整 LaTeX 工程独立维护，不自动覆盖。

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

「新建文件」可留空，自动创建项目根目录下 Git 忽略的 `workspaces/` 目录，并生成唯一的 `Untitled-<UUID>.json` 文件。指定路径时仍要求完整的 .json 绝对路径，父目录必须已存在，不覆盖任何现存文档或历史仓库。每次生成独立的 v3 示例文档和 Git 历史并打开；`paperedit new [ABSOLUTE_PATH]` 行为相同，`paperedit --offline new [ABSOLUTE_PATH]` 仅创建文件而不切换网页。

每份新文档从仓库内的 `example.json` 和 `example-data/` 模板生成，包含章节、子章节、段落、粗斜体、行内及独立公式、图和子图、表格、交叉引用、文本、对象、独立标签批注及自由放置标记。模板不被改写，工作文件及其历史不进入 Git。示例图可直接复制到其他文档；正式交叉引用和图片资源仍属于各自文档，跨文档复制时需重新建立对应引用或登记资源。没有独立的打开示例入口。

最近打开记录旁的「删除记录」仅移除共享的路径记录，不关闭当前文件、不删除文件、历史版本或阅读位置。重启不会自动恢复已删除的当前记录；主动再次打开文件会重新加入记录。CLI `paperedit forget ABSOLUTE_PATH` 使用记录中的完整路径执行相同操作。

## 多设备同步与并发编辑

前台网页每约 1.5 秒检查一次版本，返回页面时也会立即检查；其他网页或 Agent 修改正文后无需手动刷新。阅读位置仍独立共享，不实时改变其他正在阅读的页面。正在输入或打开批注弹窗时，可能影响当前编辑器的更新会暂缓至退出输入焦点或关闭弹窗；也可点击刷新主动同步。

保存仍通过服务端整份文档 revision 校验。网页以最近同步的版本进行三方合并：不同章节、批注、独立字段及互不重叠的 Markdown 段落/显式对象可自动合并；重叠修改需在冲突面板中逐项选择。目录结构、删除/恢复和重复 ID 风险按操作整体处理，不盲目覆盖。选择前可以导出本地与服务端版本。冲突与待保存草稿存入当前浏览器 IndexedDB，原标签页刷新可恢复；清除站点数据或浏览器禁止存储时无法保证恢复。外部更新导致文档内容变化时清空旧的整份快照撤销/重做栈，防止撤销别人的修改。

## 编辑与存储

- 论文树：data/outline.json 和 data/thesis/。
- 批注：data/blocks.json 和 data/blocks/。
- 图片：data/assets/。
- 历史快照：data/history/。
- 原始导入片段及标签：data/original/ 和 data/original_labels.json。

正文支持可视化编辑、MathLive 公式、图表、交叉引用、批注及批注。内部用文本和永久 ID 存储，网页不会自动写回 LaTeX 源文件。备份请复制完整的数据目录。

桌面端右键菜单支持剪切、复制、粘贴。顶部工具栏图标控制底部浮动工具栏的显示与隐藏，手机默认显示，状态记忆在浏览器中。浮动工具栏仅显示图标，按当前光标、选中文字或对象操作，保留撤销、重做，不提供历史浏览入口；触屏长按仍可访问上下文菜单。剪贴板权限不可用时，使用编辑器内剪贴板。删除批注时移入批注一览回收站，并清理相关交叉引用；可从回收站恢复。

浮动工具栏首个图标切换查看／编辑模式（默认快捷键 Ctrl+Alt+E，可自定义）。手机每次加载默认查看模式，桌面默认编辑模式。查看模式下正文、章节标题、公式和表格只读，仍可定位光标、拉选文字（包括跨段落）、复制、查看引用以及创建和编辑批注。手机切到编辑模式时直接聚焦正文以唤起系统键盘，优先沿用当前光标，拉选时定位到选区末尾，无光标时聚焦当前可见正文；切回查看模式将取消编辑焦点并收起数学键盘。

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
