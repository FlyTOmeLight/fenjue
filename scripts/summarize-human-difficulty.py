"""Export aggregate results only; never export task text, IDs or annotations."""
import argparse, json
from collections import Counter, defaultdict
from pathlib import Path

p = argparse.ArgumentParser()
p.add_argument('results', nargs='+')
p.add_argument('--out', required=True)
a = p.parse_args()
report = []
for path in a.results:
    run = json.loads(Path(path).read_text())
    rows = run['rows']
    if not rows or len(rows) != run['plannedCalls'] or len({r['dataset'] for r in rows}) != 1:
        p.error('each result file must contain completed evaluations for exactly one dataset')
    groups = defaultdict(list)
    for r in rows:
        groups[(r['rank'], r['level'])].append(r)
    levels = []
    for (rank, label), group in sorted(groups.items()):
        valid = [r for r in group if 'selection' in r]
        levels.append(dict(rank=rank, level=label, evaluations=len(group), routes=dict(Counter(r['selection']['route']['model'] + '/' + r['selection']['route']['effort'] for r in valid)), errors=dict(Counter(r['error'] for r in group if 'error' in r)), held=dict(Counter(h for r in valid for h in r['selection']['held']))))
    pairs = dict(concordant=0, discordant=0, tied=0)
    for repeat in range(run['repeats']):
        valid = [r for r in rows if r['repeat'] == repeat and 'selection' in r]
        for i, x in enumerate(valid):
            for y in valid[i+1:]:
                if x['rank'] == y['rank']:
                    continue
                scores = {'low': 0, 'medium': 1, 'high': 2}
                d = (x['rank'] - y['rank']) * (scores[x['selection']['route']['effort']] - scores[y['selection']['route']['effort']])
                pairs['concordant' if d > 0 else 'discordant' if d < 0 else 'tied'] += 1
    by_id = defaultdict(list)
    for r in rows:
        by_id[r['idDigest']].append(r)
    complete = [g for g in by_id.values() if len(g) == run['repeats'] and all('selection' in r for r in g)]
    def changes(field):
        return sum(len({json.dumps(field(r), sort_keys=True) for r in g}) > 1 for g in complete)
    times = sorted(r['elapsedMs'] for r in rows if r.get('error') != 'input-budget')
    usage = {}
    for key in ['input', 'output', 'total', 'cachedInput', 'reasoning']:
        known = [r['usage'][key] for r in rows if r['usage'][key] is not None]
        usage[key] = dict(knownCalls=len(known), knownSum=sum(known), total=sum(known) if len(known) == len(times) else None)
    report.append(dict(dataset=rows[0]['dataset'], sources=run['sources'], policy=run['policy'], questionnaireDigest=run['questionnaireDigest'], inputDigest=run['inputDigest'], repeats=run['repeats'], tasks=len(by_id), evaluations=len(rows), httpAttempts=len(times), successful=sum('selection' in r for r in rows), errors=dict(Counter(r['error'] for r in rows if 'error' in r)), levels=levels, pairs=pairs, stability=dict(completeTasks=len(complete), changedRoutes=changes(lambda r:r['selection']['route']), changedFeatures=changes(lambda r:r['classification']['features'])), latency=dict(p50Ms=times[(len(times)-1)//2] if times else None, p95Ms=times[max(0, (len(times)*95+99)//100-1)] if times else None, sumMs=sum(times)), usage=usage))
Path(a.out).parent.mkdir(parents=True, exist_ok=True)
Path(a.out).write_text(json.dumps(dict(version=1, datasets=report), ensure_ascii=False, indent=2) + '\n')
print(json.dumps(report, ensure_ascii=False, indent=2))
