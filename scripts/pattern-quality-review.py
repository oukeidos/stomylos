"""Read-only loopback review of the three frozen product quality outputs."""
import argparse, html, json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit
D = Path(__file__).resolve().parents[1] / 'test-results/pattern-quality'
REPORT_CSP = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'; worker-src 'none'; frame-ancestors 'self'"
SHELL_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
NAMES = {'Q1': 'Mixed history', 'Q2': 'Concentrated errors', 'Q3': 'Unchanged examples'}
def load(name): return json.loads((D/name).read_text())
def index():
    manifest = load('manifest.json'); ledger = load('ledger.json')
    attempts = {r['id']: r for r in ledger['attempts']}; cards = []
    for case in manifest['cases']:
        key = case['id']; row = attempts.get(key, {}); scope = case['scope']
        cost = row.get('cost_usd'); seconds = row.get('seconds')
        ready = row.get('status') == 'complete' and (D/'reports'/f'{key}.html').is_file()
        cards.append(f'''<section><button class="case" {'disabled' if not ready else ''} data-id="{key}" aria-pressed="false"><strong>{key} · {NAMES[key]}</strong><span>{scope['count']} conversations · {scope['records']} records</span><span>{('$'+format(cost,'.4f')) if cost is not None else 'Cost unavailable'} · {(str(seconds)+'s') if seconds is not None else 'Pending'}</span></button><details><summary>Source evidence</summary><pre>{html.escape(json.dumps(case['sources'],ensure_ascii=False,indent=2))}</pre></details></section>''')
    return '''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pattern report quality review</title><style>
*{box-sizing:border-box}body{margin:0;background:#f5f5f0;color:#233c35;font:15px/1.5 system-ui,sans-serif}header{padding:16px 24px;border-bottom:1px solid #d2ded7;background:#fff;display:flex;gap:18px;align-items:center;justify-content:space-between}h1{font-size:19px;margin:0}p{margin:4px 0;font-size:13px;color:#586b64}.layout{display:grid;grid-template-columns:280px 1fr;height:calc(100dvh - 93px)}aside{padding:16px;overflow:auto}section{margin-bottom:18px}.case{width:100%;text-align:left;background:#fff;border:1px solid #c6d8ce;border-radius:12px;padding:13px;cursor:pointer;font:inherit;color:inherit}.case[aria-pressed=true]{border:2px solid #2e6755;background:#eaf4ef}.case:disabled{opacity:.5;cursor:default}span{display:block;font-size:12px;margin-top:5px}.case:focus-visible,a:focus-visible{outline:3px solid #b46925;outline-offset:3px}details{padding:8px 2px;font-size:12px}summary{cursor:pointer}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:11px}iframe{width:100%;height:100%;border:0;background:#fff}a{color:#285947}.report{min-height:0}#open{white-space:nowrap}@media(max-width:760px){header{align-items:flex-start;padding:12px;flex-wrap:wrap}.layout{display:block;height:auto}aside{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;padding:8px}.case{padding:8px}.case strong{font-size:12px}.report{height:80dvh}}
</style><header><div><h1>Pattern report quality review</h1><p>Astra medium · Synthetic evidence · Original generated HTML · Practice resets when switching reports</p></div><a id="open" target="_blank" rel="noopener" hidden>Open selected report</a></header><div class="layout"><aside>''' + ''.join(cards) + '''</aside><main class="report"><iframe title="Generated learning report" sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe></main></div><script>
function select(id){const b=document.querySelector('.case[data-id="'+id+'"]');if(!b||b.disabled)return;document.querySelectorAll('.case').forEach(n=>n.setAttribute('aria-pressed',String(n===b)));document.querySelector('iframe').src='/report/'+id;const a=document.querySelector('#open');a.href='/report/'+id;a.hidden=false;history.replaceState(null,'','#'+id)}document.querySelectorAll('.case').forEach(b=>b.onclick=()=>select(b.dataset.id));select(/^#Q[123]$/.test(location.hash)?location.hash.slice(1):'Q1');
</script></html>'''
class Handler(BaseHTTPRequestHandler):
    def log_message(self,*args): pass
    def do_GET(self):
        if self.headers.get('Host') != f'127.0.0.1:{self.server.server_port}':
            self.send_error(403); return
        path = urlsplit(self.path).path; policy = SHELL_CSP
        if path == '/': data = index().encode()
        elif path in ['/report/'+key for key in NAMES]:
            key=path.rsplit('/',1)[-1]
            row=next((r for r in load('ledger.json')['attempts'] if r['id']==key),{})
            if row.get('status')!='complete': self.send_error(404); return
            data=(D/'reports'/f'{key}.html').read_bytes(); policy=REPORT_CSP
        else: self.send_error(404); return
        self.send_response(200)
        for name,value in {'Content-Type':'text/html; charset=utf-8','Content-Length':str(len(data)),'Content-Security-Policy':policy,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'}.items(): self.send_header(name,value)
        self.end_headers(); self.wfile.write(data)
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--port',type=int,default=8771);args=p.parse_args()
    server=ThreadingHTTPServer(('127.0.0.1',args.port),Handler)
    print(f'Read-only quality review: http://127.0.0.1:{server.server_port}/',flush=True)
    server.serve_forever()
