"""Three fixed product-scope quality probes; no retries, fallback, or learner data."""
import argparse, fcntl, hashlib, importlib.util, json, math, os, subprocess, sys, time
from pathlib import Path
P = Path(__file__).resolve().parents[1]
D = P / 'test-results/pattern-quality'
helper = P.parent / 'experiments/EXP-012-starter-question-renewal/run.py'
spec = importlib.util.spec_from_file_location('pattern_quality_transport', helper)
t = importlib.util.module_from_spec(spec)
spec.loader.exec_module(t)
def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def save(path, value): t.atomic(path, value)
def prepare():
    manifest = json.loads((D/'manifest.json').read_text())
    assert [c['id'] for c in manifest['cases']] == ['Q1','Q2','Q3']
    for case in manifest['cases']:
        assert sha(D/'requests'/f"{case['id']}.json") == case['request_sha256']
    frozen = {'manifest_sha256': sha(D/'manifest.json'), 'runner_sha256': sha(Path(__file__)),
              'transport_sha256': sha(helper), 'limits': {'calls': 3, 'usd': 7}, 'status': 'prepared_not_authorized'}
    if (D/'ledger.json').exists():
        assert json.loads((D/'ledger.json').read_text())['freeze'] == frozen
    else: save(D/'ledger.json', {'freeze': frozen, 'attempts': []})
    print(json.dumps(frozen))
def run():
    ledger = json.loads((D/'ledger.json').read_text())
    freeze = ledger['freeze']
    assert freeze['manifest_sha256'] == sha(D/'manifest.json')
    assert freeze['runner_sha256'] == sha(Path(__file__)) and freeze['transport_sha256'] == sha(helper)
    manifest = json.loads((D/'manifest.json').read_text()); contract = manifest['contract']
    endpoint = t.get_public(t.API+'/models/openai/gpt-6-astra/endpoints')
    ep = next(e for e in endpoint['data']['endpoints'] if e.get('tag') == 'openai')
    assert ep['provider_name'] == 'OpenAI' and ep.get('status') in [0,None]
    assert {'reasoning','max_tokens'}.issubset(ep['supported_parameters'])
    prices = ep['pricing']; pi = float(prices['prompt']); po = float(prices['completion']) + float(prices.get('internal_reasoning') or 0); fee = float(prices.get('request') or 0)
    assert all(math.isfinite(v) and v >= 0 for v in [pi,po,fee])
    save(D/'route-metadata.json', {'at':t.now(),'endpoint':ep})
    key = t.key_from_file()
    for case in manifest['cases']:
        job = case['id']; path = D/'requests'/f'{job}.json'
        if any(a['id'] == job for a in ledger['attempts']): continue
        assert sha(path) == case['request_sha256']
        body = json.loads(path.read_text()); assert all(body[k] == v for k,v in contract['parameters'].items())
        bound = len(path.read_bytes()) + 1024
        assert bound <= 20000 and bound + body['max_tokens'] <= ep['context_length']
        assert not any(bound >= p['min_prompt_tokens'] for p in prices.get('overrides', []))
        reserve = 1.15*(bound*pi + body['max_tokens']*po + fee)
        assert len(ledger['attempts']) < 3 and t.budget_used(ledger)+reserve <= 7
        row = {'id':job,'status':'dispatched','at':t.now(),'request_sha256':sha(path),'reservation_usd':reserve,'cost_usd':None}
        ledger['attempts'].append(row); save(D/'ledger.json',ledger)
        config = '\n'.join(['url = "'+t.API+'/chat/completions"','header = "Content-Type: application/json"','header = "Authorization: Bearer '+key+'"'])+'\n'
        start = time.monotonic(); safe = {}
        try:
            proc = subprocess.run(['curl','--config','-','--silent','--show-error','--max-time','300','--max-filesize','2097152','--request','POST','--data-binary','@'+str(path)],input=config,capture_output=True,text=True,timeout=310)
            if proc.returncode: raise RuntimeError('curl_'+str(proc.returncode))
            raw = json.loads(proc.stdout)
            safe = {k:raw.get(k) for k in ['id','model','provider','usage','created']}
            choices = raw.get('choices') or []
            safe['choices'] = [{'finish_reason':c.get('finish_reason'),'message':{k:(c.get('message') or {}).get(k) for k in ['content','refusal','tool_calls','function_call']}} for c in choices[:2]]
            content = choices[0].get('message',{}).get('content') if choices else None
            valid = len(choices)==1 and raw.get('model') in contract['identity']['allowed_models'] and raw.get('provider')=='OpenAI'
            valid = valid and choices[0].get('finish_reason')=='stop' and not any(choices[0].get('message',{}).get(k) for k in ['refusal','tool_calls','function_call'])
            valid = valid and isinstance(content,str) and len(content.encode())<=524288 and content.lstrip().lower().startswith('<!doctype html>') and content.rstrip().lower().endswith('</html>')
            row.update(status='complete' if valid else 'invalid_response',cost_usd=t.observed_cost(raw))
            if isinstance(content,str):
                (D/'reports').mkdir(exist_ok=True); (D/'reports'/f'{job}.html').write_text(content)
        except (OSError,ValueError,RuntimeError,subprocess.TimeoutExpired) as error:
            row['status']='operational_failure'; safe={'failure':type(error).__name__}
        row['seconds']=round(time.monotonic()-start,3)
        (D/'responses').mkdir(exist_ok=True); save(D/'responses'/f'{job}.json',safe); save(D/'ledger.json',ledger)
        print(json.dumps(row),flush=True)
        if row['cost_usd'] is not None and row['cost_usd'] > reserve: break
if __name__ == '__main__':
    parser=argparse.ArgumentParser();parser.add_argument('command',choices=['prepare','run']);parser.add_argument('--authorize-paid',action='store_true');args=parser.parse_args();os.umask(0o077)
    if args.command=='prepare': prepare()
    else:
        if not args.authorize_paid: parser.error('Explicit authorization of 3 calls / USD7 is required')
        with (D/'execution.lock').open('a+') as lock: fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB);run()
