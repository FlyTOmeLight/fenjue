"""Prepare local inputs; never include solutions or difficulty labels in prompts."""
import argparse, hashlib, json
from collections import Counter
from pathlib import Path
import pyarrow.parquet as pq

p = argparse.ArgumentParser()
p.add_argument('--swe')
p.add_argument('--gaia')
p.add_argument('--out', required=True)
p.add_argument('--per-level', type=int, default=20)
a = p.parse_args()
if not a.swe and not a.gaia:
    p.error('at least one of --swe/--gaia is required')
if a.per_level < 1:
    p.error('--per-level must be positive')
tasks, sources = [], []
for name, path, revision in [('swe', a.swe, '78f471bf655a3137b2e8a75af1501690ec009ec3'), ('gaia', a.gaia, '682dd723ee1e1697e00360edccf2366dc8418dd9')]:
    if not path:
        continue
    rows = pq.read_table(path).to_pylist()
    labels = ['<15 min fix', '15 min - 1 hour', '1-4 hours', '>4 hours'] if name == 'swe' else ['1', '2', '3']
    eligible = rows if name == 'swe' else [r for r in rows if not r['file_name']]
    counts = Counter(str(r['difficulty' if name == 'swe' else 'Level']) for r in eligible)
    for rank, label in enumerate(labels):
        group = [r for r in eligible if str(r['difficulty' if name == 'swe' else 'Level']) == label]
        id_key = 'instance_id' if name == 'swe' else 'task_id'
        group.sort(key=lambda r: hashlib.sha256(('fenjue-human-v1:' + name + ':' + r[id_key]).encode()).hexdigest())
        for r in group[:a.per_level]:
            prompt = f"Fix the following issue in the {r['repo']} repository.\n\n{r['problem_statement']}" if name == 'swe' else r['Question']
            tasks.append(dict(dataset=name, id=r[id_key], level=label, rank=rank, prompt=prompt))
    sources.append(dict(dataset=name, revision=revision, sha256=hashlib.sha256(Path(path).read_bytes()).hexdigest(), total=len(rows), eligible=len(eligible), counts=dict(counts)))
out = Path(a.out)
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(json.dumps(dict(version=1, seed='fenjue-human-v1', perLevel=a.per_level, sources=sources, tasks=tasks), ensure_ascii=False, indent=2))
out.chmod(0o600)
print(json.dumps(dict(sources=sources, selected=dict(Counter(t['dataset'] + ':' + t['level'] for t in tasks))), indent=2))
