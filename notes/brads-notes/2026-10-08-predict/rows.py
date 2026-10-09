# Row by row: the same run analysed with two believed truths, e.g. pt-lab's
# (r05, today's code) and the predicted one (m05). Rows whose every field
# agrees to 1e-6 px are the same; the rest are listed.
#   python3 rows.py r05 m05 [ignore-field ...]
import json, sys
A, B, IGNORE = sys.argv[1], sys.argv[2], set(['identifiedFrom'] + sys.argv[3:])
TOL = 1e-6
def num(v): return v if isinstance(v, (int, float)) and not isinstance(v, bool) else None
def close(a, b):
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(close(a[k], b[k]) for k in a)
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(close(x, y) for x, y in zip(a, b))
    if num(a) is not None and num(b) is not None: return abs(a - b) <= TOL * max(1, abs(a))
    return a == b
total = {'same': 0, 'differ': 0}
for r in ['x', 'y', 'z', 'turn', 'test']:
    a = json.load(open(f'results/stack-2g-{r}-{A}/pairs/gap-sweep.json'))['rows']
    b = json.load(open(f'results/stack-2g-{r}-{B}/pairs/gap-sweep.json'))['rows']
    ka = {(x['shot'], x['pair']): x for x in a}
    kb = {(x['shot'], x['pair']): x for x in b}
    same = 0
    for k in sorted(set(ka) | set(kb)):
        x, y = ka.get(k), kb.get(k)
        if x is None or y is None:
            print(f'  {r} {k[0]} pair {k[1]}: only with {B if x is None else A}'); total['differ'] += 1; continue
        keys = [f for f in sorted(set(x) | set(y)) if f not in IGNORE and not close(x.get(f), y.get(f))]
        if keys:
            total['differ'] += 1
            t = lambda z: (z.get('tracked') or {}).get('gapPx')
            print(f"  {r} {k[0]} pair {k[1]}: {','.join(keys)}; tracked {t(x)} -> {t(y)}, true {x.get('trueGapPx')} -> {y.get('trueGapPx')}")
        else: same += 1
    total['same'] += same
    print(f'{r}: {same} of {len(set(ka) | set(kb))} rows the same')
print(total)
