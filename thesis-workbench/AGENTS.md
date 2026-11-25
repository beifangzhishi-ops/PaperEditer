# PaperEditer：Agent 读取约定

两个独立空间。默认 data/outline.json 是正式论文树索引，data/thesis/ 下每节一个 Markdown 文件；data/blocks.json 是独立知识块索引，data/blocks/ 下每块一个 Markdown 文件，初始为空。实际数据目录可通过 PAPEREDITER_DATA_DIR 配置。工程模式下，workspace.local.json 指向实际 .paper 文本索引；其 files 映射将逻辑路径解析为 .paper 同目录下的实际相对路径，objects 记录对象路径与定位信息。先确认活动工作区，再读取普通文件；可使用 workspace.py list/unpack/refresh。修改时优先调用应用保存接口并检查 revision；直接编辑普通文件后用 refresh 更新派生对象索引。不得将知识块当作正式论文正文。original/ 是首次导入的 TeX 片段。只在用户要求时同步，不自动覆盖 TeX 或知识块。用户数据、导入源、原始图片和历史快照均不得提交到公开仓库。

先按标题/关键词搜索 outline 或 blocks 索引，再读所需文件。对象引用使用 `[[ref:永久ID]]`，公式用 `[[eqref:永久ID]]`，嵌入知识块用 `[[embed:块ID]]`；对象定义用 `:::equation ID`、`:::figure ID`、`:::table ID`，结束行为独立的 `:::`。图表首行是题注。ID 保持稳定，编号由当前树顺序计算；不把显示编号写死。引用及关联从 Markdown 源文件动态建立。公式保留 LaTeX 源码。外部编辑先备份，再原子替换；结构索引与正文路径须一致。应用会检查并发修改；不要在网页正在编辑同一文件时覆盖。

