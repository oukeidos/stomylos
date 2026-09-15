"""Review synthetic preflight outputs offline; never dispatch inference."""
import json,pathlib,difflib
p=pathlib.Path(__file__).resolve().parents[1]/'test-results/conversation-limits'
m=json.loads((p/'manifest.json').read_text());rows=json.loads((p/'live-results.json').read_text());review=[]
for r in rows:
 c=next(c for c in m['cases'] if c['id']==r['id']);item={'id':r['id'],'transport':r['status']}
 f=p/(r['id']+'-response.txt')
 if f.exists() and c.get('grammar'):
  try:
   units=json.loads(f.read_text())['units'];src=[s for s in c['source'] if s['role']=='user'];details=[]
   for s,u in zip(src,units):
    original=s['content'];corrected=u['corrected_text'];expected=original.replace('I likes','I like')
    details.append({'index':u['index'],'source_bytes':len(original.encode()),'corrected_bytes':len(corrected.encode()),'targeted_error_retained':'I likes' in corrected,'exact_targeted_correction':corrected==expected,'large_loss':len(corrected)<len(original)*.8})
   item.update({'units':len(units),'expected_units':len(src),'source_bytes':sum(x['source_bytes'] for x in details),'corrected_bytes':sum(x['corrected_bytes'] for x in details),'large_loss_count':sum(x['large_loss'] for x in details),'targeted_error_retained_count':sum(x['targeted_error_retained'] for x in details),'details':details})
  except (ValueError,KeyError,TypeError) as e:item['review_error']=type(e).__name__
 if f.exists() and c.get('memory'):
  try:
   notes=json.loads(f.read_text())['add'];item.update({'notes':len(notes),'has_green':any('green' in n.lower() for n in notes),'has_blue':any('blue' in n.lower() for n in notes)})
  except (ValueError,KeyError,TypeError) as e:item['review_error']=type(e).__name__
 if f.exists() and c.get('genie'):item['result']=json.loads(f.read_text())
 review.append(item)
(p/'review.json').write_text(json.dumps(review,indent=2))
print(json.dumps([{k:v for k,v in i.items() if k!='details'} for i in review],indent=2))
