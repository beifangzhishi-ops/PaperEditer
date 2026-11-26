"""Three-way document merge, shared by the service and CLI."""
import collections
import difflib
import re

from workspace import OBJECT

MISSING = object()
SPACES = ("thesis", "blocks")


def node_content(node):
    return {k: v for k, v in node.items() if k not in ("parent", "order", "level")} if node is not None else MISSING


def chunks(raw):
    out, end = [], 0
    def prose(s):
        out.extend(x for x in re.split(r"(\n[ \t]*\n+)", s) if x)
    for m in OBJECT.finditer(raw):
        prose(raw[end:m.start()])
        out.append(m[0])
        end = m.end()
    prose(raw[end:])
    return out


def merge_body(base, local, remote, choose):
    original, a, b = chunks(base), chunks(local), chunks(remote)
    if max(len(original), len(a), len(b)) > 3000:
        return choose("body", local, remote)
    def edits(value, side):
        return [(i, j, value[k:l], side) for op, i, j, k, l in difflib.SequenceMatcher(None, original, value, autojunk=False).get_opcodes() if op != "equal"]
    remaining = edits(a, "local") + edits(b, "remote")
    combined = []
    def overlap(x, y):
        i, j, _, _ = x
        k, l, _, _ = y
        return i == k or max(i, k) < min(j, l) or (i == j and k <= i <= l) or (k == l and i <= k <= j)
    while remaining:
        group = [remaining.pop(0)]
        for x in group:
            for i in range(len(remaining) - 1, -1, -1):
                y = remaining[i]
                if x[3] != y[3] and overlap(x, y):
                    group.append(remaining.pop(i))
        start, end = min(x[0] for x in group), max(x[1] for x in group)
        left = [x for x in group if x[3] == "local"]
        right = [x for x in group if x[3] == "remote"]
        if not left or not right:
            combined.extend(group)
            continue
        def apply(edits):
            value = original[start:end]
            for i, j, values, _ in sorted(edits, key=lambda x: x[0], reverse=True):
                value[i-start:j-start] = values
            return "".join(value)
        l, r = apply(left), apply(right)
        combined.append((start, end, [l if l == r else choose("body:" + str(start) + ":" + str(end), l, r)], "both"))
    value = original[:]
    for i, j, values, _ in sorted(combined, key=lambda x: x[0], reverse=True):
        value[i:j] = values
    return "".join(value)


def block_label(body):
    text = re.sub(r"\[\[(?:ref|eqref|embed|cite):[^\]]+\]\]", "", body)
    text = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", text)
    text = re.sub(r"^:::[^\n]*$", "", text, flags=re.M)
    # The visual editor limits to 36 UTF-16 units.
    text = re.sub(r"\s+", " ", text).strip()
    return text.encode("utf-16-le")[:72].decode("utf-16-le", "ignore") or "知识块"


def merge_content(base, local, remote, choices=None):
    choices = choices or {}
    if local == remote or base == local:
        return {"state": remote, "conflicts": []}
    if base == remote:
        return {"state": local, "conflicts": []}
    conflicts = []
    def choose(key, label, a, b):
        if choices.get(key) not in ("local", "remote"):
            conflicts.append(dict(key=key, label=label, local=None if a is MISSING else a, remote=None if b is MISSING else b))
        return b if choices.get(key) == "remote" else a
    def select(key, label, o, a, b):
        if a == b or b == o:
            return a
        if a == o:
            return b
        return choose(key, label, a, b)
    result = {}
    for space in SPACES:
        original, mine, theirs = (x[space] for x in (base, local, remote))
        om, lm, rm = ({n["id"]: n for n in seq} for seq in (original, mine, theirs))
        def layout(seq):
            return [(n["id"], n.get("parent") or None) for n in seq]
        ol, ll, rl = map(layout, (original, mine, theirs))
        delete_edit = any((id not in lm and id in rm and node_content(n) != node_content(rm[id])) or
                          (id not in rm and id in lm and node_content(n) != node_content(lm[id])) for id, n in om.items())
        if delete_edit or (ol != ll and ol != rl and ll != rl):
            selected = choose("structure:" + space, ("博论树" if space == "thesis" else "知识块") + "：目录结构或删除冲突", mine, theirs)
        else:
            selected = theirs if ol == ll else mine
        result[space] = []
        for i, n in enumerate(selected):
            id = n["id"]
            o, a, b = (m.get(id) for m in (om, lm, rm))
            oc, ac, bc = map(node_content, (o, a, b))
            prefix, label = space + ":" + id, n.get("title") or id
            if a is None or b is None:
                value = node_content(n)
            elif o is None:
                value = select(prefix, label, MISSING, ac, bc)
            elif ac == bc or bc == oc:
                value = ac
            elif ac == oc:
                value = bc
            else:
                value = {}
                auto_title = space == "blocks" and a["title"] == block_label(a["body"]) and b["title"] == block_label(b["body"])
                for field in dict.fromkeys([*oc, *ac, *bc]):
                    x, y, z = (m.get(field, MISSING) for m in (oc, ac, bc))
                    if field == "body" and x != y and x != z and y != z:
                        v = merge_body(x, y, z, lambda key, l, r: choose(prefix + ":" + key, label + "：正文对象", l, r))
                    elif field == "title" and auto_title:
                        v = y
                    else:
                        v = select(prefix + ":" + field, label + "：" + field, x, y, z)
                    if v is not MISSING:
                        value[field] = v
                if auto_title:
                    value["title"] = block_label(value["body"])
            result[space].append(dict(value, parent=n.get("parent") or None, order=i, level=n["level"]))
    lt, rt = base["trash"] != local["trash"], base["trash"] != remote["trash"]
    def intersects(transaction, other):
        old, a, b = ({n["id"]: n for space in SPACES for n in s[space]} for s in (base, transaction, other))
        touched = {id for id in old.keys() | a.keys() if node_content(old.get(id)) != node_content(a.get(id))}
        removed = set()
        for id, n in old.items():
            if id not in a:
                removed.add(id)
                removed.update(m[2] for m in OBJECT.finditer(n["body"]))
                removed.update(re.findall(r'wb-id:([^\s"]+)', n["body"]))
        for id in old.keys() | b.keys():
            if node_content(old.get(id)) != node_content(b.get(id)):
                if id in touched:
                    return True
                n = b.get(id)
                if n and any(":" + r + "]]" in n["body"] or r in str([n.get("annotation"), n.get("objectBindings"), n.get("freePlacements")]) for r in removed):
                    return True
        return any(c["key"] == "structure:blocks" for c in conflicts)
    if (lt and rt) or (lt and intersects(local, remote)) or (rt and intersects(remote, local)):
        conflicts.clear()
        state = choose("trash-transaction", "回收站及关联引用操作冲突", local, remote)
        return {"state": state, "conflicts": conflicts}
    result["trash"] = select("trash", "回收站", base["trash"], local["trash"], remote["trash"])
    def identities(s):
        counts = collections.Counter()
        for space in SPACES:
            for n in s[space]:
                counts[n["id"]] += 1
                counts.update(m[2] for m in OBJECT.finditer(n["body"]))
                counts.update(re.findall(r'wb-id:([^\s"]+)', n["body"]))
        return counts
    counts = [identities(s) for s in (base, local, remote)]
    if any(count > max(1, *(c[id] for c in counts)) for id, count in identities(result).items()):
        conflicts.clear()
        state = choose("identity-transaction", "对象移动或复制冲突（避免重复 ID）", local, remote)
        return {"state": state, "conflicts": conflicts}
    return {"state": result, "conflicts": conflicts}
