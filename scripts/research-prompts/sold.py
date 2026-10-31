import sys, json, time, re, os, urllib.request, html
UA = {'User-Agent': 'BroadwayScorecard research ' + os.environ.get('SEC_CONTACT_EMAIL', '')}
if len(sys.argv) != 3 or 'SEC_CONTACT_EMAIL' not in os.environ: sys.exit('usage: SEC_CONTACT_EMAIL=you@x python3 -I sold.py <records.tsv> <outdir>  (outdir must be <work>/sec)')
tsv, outdir = sys.argv[1], sys.argv[2]
os.makedirs(outdir, exist_ok=True)
def get(url, cache):
    p = os.path.join(outdir, cache)
    if os.path.exists(p): return open(p, encoding='utf-8').read()
    s = urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30).read().decode('utf-8', 'replace')
    open(p, 'w', encoding='utf-8').write(s); time.sleep(0.35); return s
def g(tag, s):
    m = re.search(r'<%s>(.*?)</%s>' % (tag, tag), s, re.S); return html.unescape(m.group(1).strip()) if m else None
for line in open(tsv, encoding='utf-8'):
    slug, cik, adsh, cap, est = line.rstrip('\n').split('\t')
    try:
        doc = get('https://www.sec.gov/Archives/edgar/data/%d/%s/primary_doc.xml' % (int(cik), adsh), adsh + '.xml')
        sub = json.loads(get('https://data.sec.gov/submissions/CIK%010d.json' % int(cik), 'sub_%s.json' % cik))
    except Exception as e:
        print('\t'.join([slug, 'ERR', str(e)])); continue
    off, sold, inv = g('totalOfferingAmount', doc), g('totalAmountSold', doc), g('totalNumberAlreadyInvested', doc)
    rec = sub.get('filings', {}).get('recent', {})
    forms = [(f, d, a) for f, d, a in zip(rec.get('form', []), rec.get('filingDate', []), rec.get('accessionNumber', [])) if f.startswith('D')]
    later = [f'{f} {d}' for f, d, a in forms if a.replace('-', '') != adsh]
    try: pct = round(100 * float(sold) / float(off)) if off and off.isdigit() and sold else None
    except Exception: pct = None
    print('\t'.join(map(str, [slug, cap, off, sold, pct, inv, ';'.join(later) or '-', est])))
