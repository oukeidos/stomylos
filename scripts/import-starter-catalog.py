"""Build current English catalog and direct v1 reconstruction delta."""
import json,hashlib
from pathlib import Path
root=Path(__file__).resolve().parents[1]
source=root.parent/'experiments/EXP-030-starter-pool-diversity/drafts/direct-pool/english-revision'
assets=root/'src/main/assets'
raw=(source/'ENGLISH_REVISED.jsonl').read_bytes()
verification=json.loads((source/'FINAL_VERIFICATION.json').read_text())
assert hashlib.sha256(raw).hexdigest()==verification['output_sha256']['ENGLISH_REVISED.jsonl']
rows=[json.loads(s) for s in raw.decode().splitlines()]
oldraw=(assets/'starter-catalog-v1.json').read_bytes();old=json.loads(oldraw)
manifest=json.loads((assets/'starter-catalog-v1-manifest.json').read_text())
assert len(rows)==5000 and [(r['id'],r['subject'],r['activity']) for r in rows]==[(r['id'],r['subject'],r['activity']) for r in old]
encode=lambda value:json.dumps(value,ensure_ascii=False,separators=(',',':'))+'\n'
assert encode(old).encode()==oldraw
payload=encode(rows)
delta={a['id']:a['en'] for a,b in zip(old,rows) if a['en']!=b['en']}
assert encode([dict(r,en=delta.get(r['id'],r['en'])) for r in rows]).encode()==oldraw
(assets/'starter-catalog-current.json').write_text(payload)
(assets/'starter-catalog-v1-delta.json').write_text(encode(delta))
manifest.update(revision=2,version='stomylos_catalog_v2',sha256=hashlib.sha256(payload.encode()).hexdigest())
(assets/'starter-catalog-current-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print('Imported 5000 rows; reverse delta:',len(delta))
