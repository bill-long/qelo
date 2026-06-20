#!/usr/bin/env bash
# Poll PR #48 Copilot review state (throwaway).
gh api graphql -f query='query{repository(owner:"bill-long",name:"qelo"){pullRequest(number:48){reviews(last:6){nodes{author{login} state submittedAt body}} reviewThreads(last:40){nodes{isResolved isOutdated path line comments(first:1){nodes{author{login} body}}}}}}}' | python -c "
import sys,json
d=json.load(sys.stdin)['data']['repository']['pullRequest']
revs=d['reviews']['nodes']
print('REVIEWS:')
for r in revs:
    print(' -',r['author']['login'],r['state'],r['submittedAt'],'|',(r['body'][:160].replace(chr(10),' ') if r['body'] else ''))
th=d['reviewThreads']['nodes']
openn=[t for t in th if not t['isResolved']]
print('THREADS total',len(th),'OPEN',len(openn))
for t in th:
    c=t['comments']['nodes'][0]
    print((' OPEN ' if not t['isResolved'] else ' res  ')+(t['path'] or '')+':'+str(t['line'])+' '+c['author']['login']+': '+c['body'][:200].replace(chr(10),' '))
"
