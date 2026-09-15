"""Read public endpoint capabilities only; no inference or credentials."""
import json, urllib.request, pathlib, datetime
root=pathlib.Path(__file__).resolve().parents[1]
out=root/'test-results/conversation-limits';out.mkdir(parents=True,exist_ok=True)
cfg=json.loads((root/'src/main/runtime-config.json').read_text())
models=[c['model'] for c in cfg['conversation']['characters']]+[cfg['grammar']['request_parameters']['model'],'openai/gpt-5.6-terra','openai/gpt-5.6-luna']
rows=[]
for model in models:
 try:
  with urllib.request.urlopen('https://openrouter.ai/api/v1/models/'+model+'/endpoints',timeout=30) as r: data=json.load(r)
  (out/(model.replace('/','_')+'-endpoints.json')).write_text(json.dumps(data,indent=2))
  endpoints=data.get('data',{}).get('endpoints',[])
  row={'model':model,'endpoints':[{k:e.get(k) for k in ['name','provider_name','context_length','max_prompt_tokens','max_completion_tokens','pricing','supported_parameters']} for e in endpoints]}
 except Exception as e: row={'model':model,'error':type(e).__name__+': '+str(e)}
 rows.append(row)
 print(json.dumps(row),flush=True)
(out/'capabilities.json').write_text(json.dumps({'checked_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'rows':rows},indent=2))
