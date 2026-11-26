# PaperEditer：Agent 读写约定

正式文档为单个 UTF-8 JSON（格式 v3）。正文、目录、批注、回收站和稳定对象 ID 在文件内；图片、TeX、PPT 等外部资源使用服务端绝对路径（支持 UNC）。正文 Markdown 不是独立工作文件。旧 v2 格式在打开时迁移，保留原索引备份及原数据目录；不要编辑旧副本。

文档默认只读。Agent 可以读取文档，但修改必须通过 PaperEditer CLI 或 API，禁止直接解除只读后覆盖。CLI 与网页共享校验、并发合并和历史记录。默认目标是服务当前工作区；`--workspace ABSOLUTE_PATH` 可操作其他文档而不切换网页。命令可在任意目录运行；若未安装，先在编辑器目录执行 `python install_cli.py`：

~~~sh
paperedit status
paperedit list --space thesis
paperedit search "关键词"
paperedit read OBJECT_ID
paperedit edit --file changes.json -m "修改说明"
paperedit history OBJECT_ID
paperedit diff COMMIT --object OBJECT_ID
paperedit tag --name "重要版本"
paperedit restore COMMIT --object OBJECT_ID --revision REVISION
~~~

edit 批量文件格式：`{"revision":"读取时返回的版本","operations":[{"op":"update","id":"OBJECT_ID","body":"新内容"}]}`。不能用猜测或刷新得到的新 revision 强行覆盖旧草稿；并发冲突时重新读取、合并并提交。每次有效保存自动进入独立本地 Git，不需要额外 commit；tag 只命名版本。历史仓库不设远程，不得推送用户数据。

Windows 使用原生 `paperedit.exe`，Python 可直接 `subprocess.run(["paperedit", ...], capture_output=True, check=True)`，不需要 shell 或脚本绝对路径。用 `json.loads(result.stdout)` 解析结果；批量文件使用 UTF-8，标准输入使用 UTF-8 JSON 字节。不要将 API 超时或内部错误当成切换工作区的理由。

**严禁把含中文的 PowerShell here-string 直接通过默认管道传给 Python 或 CLI。** Windows PowerShell 5 的默认 `$OutputEncoding` 可能是 ASCII，将正文不可逆地替换为问号。用文件编辑工具写入 UTF-8 JSON，或用 ASCII-only Python 源代码（中文用 Unicode 转义），通过 `json.dumps(batch, ensure_ascii=True).encode("ascii")` 传给 `subprocess.run(["paperedit","edit","--file","-"], input=..., capture_output=True, check=True)`。提交前读取并检查批量文件中的 Unicode 文本是否与草稿一致；提交后重新读取对象、核对内容及历史。不得把乱码提交当成成功。服务端会拒绝明显编码损坏，但启发式检查不能替代逐项核对。

先搜索、读取必要的对象，再按 ID 编辑。正文段落有持久 ID；公式、图、表采用 `:::equation ID`、`:::figure ID`、`:::table ID`，结束行为独立的 `:::`。正式 TeX 交叉引用使用 `[[ref:ID]]`、`[[eqref:ID]]`，仅引用正式论文对象；`[[embed:ID]]` 是批注位置标记，不是交叉引用。兼容存储字段仍为 `blocks`。每条批注最多一个实际位置（正文内标签、`objectBindings` 或 `freePlacements`），不得重复绑定，复制需创建新 ID。剪切或旧数据可能暂时未放置。旧多位置批注打开时自动拆分，历史保留原版本。显示编号由目录顺序计算，不写死。批注不属于正式论文正文。外部 TeX、PPT、图片保持原权限，只有明确要求才修改源文件。图片历史记录路径和指纹，不保存二进制内容。

服务关闭可用 `--offline --workspace ABSOLUTE_PATH` 直接调用同一个跨进程加锁的核心。不要使用旧 workspace.py refresh 操作 v3 文件。损坏文件由 `recover` 命令显式恢复，保留损坏原件。数据、外部资源、历史、备份与锁文件均不得提交到编辑器 Public 仓库。
