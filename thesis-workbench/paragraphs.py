"""Persistent IDs for the prose portions of Markdown, without hidden markers."""
import collections
import difflib
import hashlib
import re
import uuid

from workspace import OBJECT


def prose_spans(body):
    """Match visualParts: split prose on blank lines; explicit objects and embeds are separate."""
    result = []
    def scan(start, end):
        raw = body[start:end]
        at = 0
        for part in re.split(r"(\r?\n[ \t]*\r?\n+)", raw):
            text = part.strip()
            if text and not re.fullmatch(r"\[\[embed:[^\]\n]+\]\]", text):
                begin = start + at + len(part) - len(part.lstrip())
                result.append((begin, begin + len(text), text))
            at += len(part)
    at = 0
    for m in OBJECT.finditer(body):
        scan(at, m.start())
        at = m.end()
    scan(at, len(body))
    return result


def fingerprint(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def nodes(doc):
    return {n["id"]: n for s in ("thesis", "blocks") for n in doc.get(s, [])}


def paragraph_index_valid(doc):
    mapping = doc.get("paragraphs")
    if not isinstance(mapping, dict):
        return False
    by_owner = nodes(doc)
    seen = set()
    if mapping.keys() != by_owner.keys():
        return False
    for owner, n in by_owner.items():
        records = mapping[owner]
        spans = prose_spans(n["body"])
        if not isinstance(records, list) or len(records) != len(spans):
            return False
        for record, (_, _, text) in zip(records, spans):
            if not isinstance(record, dict) or not isinstance(record.get("id"), str) or not re.fullmatch(r"para-[0-9a-f]{32}", record["id"]) or record["id"] in seen or record.get("hash") != fingerprint(text):
                return False
            seen.add(record["id"])
    return True


def rebuild(old, new):
    """Preserve equal and uniquely moved paragraphs, then align replacements.

    Ambiguous repeated text or multiple unrelated replacements cannot carry
    an unambiguous identity in a raw Markdown edit; prefer a new ID.
    """
    previous = old.get("paragraphs", {}) if old else {}
    old_nodes, new_nodes = nodes(old or {}), nodes(new)
    before, after, assigned, used = {}, {}, {}, set()
    for owner, n in old_nodes.items():
        spans = prose_spans(n["body"])
        records = previous.get(owner, [])
        if len(spans) == len(records):
            before[owner] = [(fingerprint(s[2]), r["id"]) for s, r in zip(spans, records) if isinstance(r, dict) and "id" in r and r.get("hash") == fingerprint(s[2])]
            if len(before[owner]) != len(spans):
                before[owner] = []
    for owner, n in new_nodes.items():
        after[owner] = [fingerprint(s[2]) for s in prose_spans(n["body"])]
        assigned[owner] = [None] * len(after[owner])
    replacements = []
    for owner, hashes in after.items():
        records = before.get(owner, [])
        old_hashes = [r[0] for r in records]
        # Identical text is common; bound quadratic comparison for large sections.
        if old_hashes == hashes:
            assigned[owner] = [r[1] for r in records]
            used.update(assigned[owner])
            continue
        matcher = difflib.SequenceMatcher(None, old_hashes, hashes, autojunk=len(hashes) > 2000)
        for op, i, j, k, l in matcher.get_opcodes():
            if op == "equal":
                for oi, ni in zip(range(i, j), range(k, l)):
                    id = records[oi][1]
                    assigned[owner][ni] = id
                    used.add(id)
            elif op == "replace":
                replacements.append((owner, i, j, k, l))
    unmatched_old, unmatched_new = collections.defaultdict(list), collections.defaultdict(list)
    for records in before.values():
        for h, id in records:
            if id not in used:
                unmatched_old[h].append(id)
    for owner, hashes in after.items():
        for i, h in enumerate(hashes):
            if assigned[owner][i] is None:
                unmatched_new[h].append((owner, i))
    for h, matches in unmatched_new.items():
        if len(matches) == len(unmatched_old[h]) == 1:
            owner, i = matches[0]
            id = unmatched_old[h][0]
            assigned[owner][i] = id
            used.add(id)
    for owner, i, j, k, l in replacements:
        old_items = before.get(owner, [])[i:j]
        new_positions = [x for x in range(k, l) if assigned[owner][x] is None]
        remaining = [r for r in old_items if r[1] not in used]
        # A single edited paragraph (or equal-size replacement region) keeps
        # its identity; splits/joins keep one existing ID where possible.
        if remaining and new_positions:
            if len(remaining) == len(new_positions) or min(len(remaining), len(new_positions)) == 1:
                for (_, id), ni in zip(remaining, new_positions):
                    assigned[owner][ni] = id
                    used.add(id)
    return {owner: [{"id": id or "para-" + uuid.uuid4().hex, "hash": h} for id, h in zip(assigned[owner], hashes)] for owner, hashes in after.items()}


def paragraph_value(doc, id):
    for owner, records in doc.get("paragraphs", {}).items():
        for i, record in enumerate(records):
            if record["id"] != id:
                continue
            for space in ("thesis", "blocks"):
                n = next((n for n in doc[space] if n["id"] == owner), None)
                if n:
                    spans = prose_spans(n["body"])
                    if i < len(spans) and fingerprint(spans[i][2]) == record["hash"]:
                        start, end, raw = spans[i]
                        return dict(space=space, owner=owner, kind="paragraph", raw=raw, start=start, end=end)
    return None
