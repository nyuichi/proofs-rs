"""Generate additive, repeatable staging fixtures; never a schema migration."""
import json, uuid
from pathlib import Path
D=json.loads(Path('fixtures/staging-demo.json').read_text())
Q=[]
def val(x):
    if x is None:return 'NULL'
    if isinstance(x,int):return str(x)
    return "'"+str(x).replace("'","''").replace("\n", "'||char(10)||'")+"'"
def insert(table, **values):
    Q.append('INSERT OR IGNORE INTO '+table+'('+','.join(values)+') VALUES('+','.join(v[1] if isinstance(v,tuple) else val(v) for v in values.values())+');')
def expr(s):return ('sql',s)
def uid(s):return str(uuid.uuid5(uuid.NAMESPACE_URL,'https://proofs.rs/staging-demo/v1/'+s))
def date(n):return f'2026-09-{min(28,10+n):02d}T10:00:00.000Z'
def rel(c):return expr("(SELECT r.id FROM releases r JOIN crates c ON c.id=r.crate_id WHERE c.name="+val(c['name'])+" AND r.version="+val(c['v']+'-demo.1')+")")
for i,name in enumerate(['mira','nora','emil','soren']):
    insert('users',id=uid(name),github_id=-91001-i,username='demo_'+name,role='user',status='active',accepted_terms_version='2026-09-21',terms_accepted_at=date(0),created_at=date(0))
    insert('notification_preferences',user_id=uid(name),replies=0,report_comments=0)
for t in D['tools']:
    insert('tools',id='demo-'+t['id'],name=t['name']+' (demo)',description=t['description']+' Staging fixture; versions are illustrative.',official_url=t['url'])
    for v in t['versions']:insert('tool_versions',id=uid(t['id']+v),tool_id='demo-'+t['id'],version=v)
for c in D['crates']:
    insert('crates',name=c['name'],description=c['desc'])
    insert('releases',crate_id=expr('(SELECT id FROM crates WHERE name='+val(c['name'])+')'),version=c['v']+'-demo.1',created_at=date(0))
    # Deliberately no doc_snapshots: dummy APIs must not masquerade as an imported catalog.
    for a in c['apis']:
        unsafe='unchecked' in a
        insert('api_items',id=uid(c['name']+'/'+a),release_id=rel(c),canonical_key='demo:'+a,display_path=c['name'].replace('-','_')+'::'+a,kind='method' if '::' in a else 'function',is_unsafe=int(unsafe),signature=('pub unsafe fn ' if unsafe else 'pub fn ')+a.split('::')[-1]+'(/* demo signature */)',upstream_url='https://docs.rs/'+c['name']+'/'+c['v'])
claims=D['claims']+[dict(D['claims'][1],id=104,title='',comments=[],revision=1,description='')]
groups={}
for c in claims:groups.setdefault((c['crate'],c['method'].split(' · ')[0]),[]).append(c)
def rid(key):return expr("(SELECT id FROM reports WHERE create_key="+val('staging-demo-reports-v1-'+key[0]+'-'+key[1])+")")
for index,(key,items) in enumerate(groups.items()):
    crate=next(c for c in D['crates'] if c['name']==key[0])
    t=next(t for t in D['tools'] if t['name']==key[1])
    author=items[0]['author']; rev=max(c['revision'] for c in items)
    created=date(index)
    insert('reports',create_key='staging-demo-reports-v1-'+key[0]+'-'+key[1],release_id=rel(crate),author_id=uid(author),withdrawn_at=date(10) if items[0]['id']==35 else None,created_at=created,updated_at=date(10) if rev>1 else created)
    for c in items:
        insert('claims',id=uid('claim/'+str(c['id'])),report_id=rid(key),api_item_id=uid(c['crate']+'/'+c['api']),property='no_ub' if c['property']=='No undefined behavior' else 'panic_contract',created_at=created)
    for revision in range(1,rev+1):
        insert('report_revisions',report_id=rid(key),revision_no=revision,title=key[0]+' verification with '+key[1]+(' — initial scope' if revision<rev else ''),explanation='Synthetic staging report based on the original design examples.',trusted_assumptions='Illustrative tool implementation, compiler and library models.',tool_version_id=uid(t['id']+t['versions'][0]),environment='See each claim for the concrete types, bounds and features.',evidence_url='https://example.com/proofs-rs-demo/reports/'+str(index+1),limitations='Synthetic staging data. No proof was run.',created_at=created if revision==1 else date(10))
        for pos,c in enumerate(items):
            title=c['title'] or c['property']+' for '+c['crate']+'::'+c['api']+' (with '+key[1]+' '+t['versions'][0]+')'
            insert('claim_revisions',claim_id=uid('claim/'+str(c['id'])),report_id=rid(key),report_revision=revision,position=pos,title=title,precondition=c['condition']+'\n'+c['formula'],explanation=c['description'],trusted_assumptions='',evidence_url='' if c['id']==104 else 'https://example.com/proofs-rs-demo/'+str(c['id']),limitations=c['scope'])
    sequence=0
    for c in items:
        for j,cm in enumerate(c['comments']):
            name,_,body,*_=cm;sequence+=1
            parent=uid('comment/'+str(c['id'])+'/'+str(j-1)) if j and (name==c['author'] or c['id']==17 and j==2) else None
            insert('report_comments',id=uid('comment/'+str(c['id'])+'/'+str(j)),report_id=rid(key),sequence_no=sequence,revision_no=1 if j<2 else rev,author_id=uid(name),reply_to_id=parent,body=body,created_at=date(min(10,index+j)))
        for name in ['mira','nora','emil','soren'][:c['id']%4]:
            insert('claim_stars',claim_id=uid('claim/'+str(c['id'])),user_id=uid(name),created_at=date(10))
    for name in ['mira','nora','emil','soren'][:(index%4)+1]:insert('report_stars',report_id=rid(key),user_id=uid(name),created_at=date(10))
    if key==('arrayvec','Kani'):
        insert('report_comments',id=uid('deleted'),report_id=rid(key),sequence_no=sequence+1,revision_no=rev,author_id=uid('soren'),body=None,created_at=date(9),deleted_at=date(10),edit_version=2)
        insert('report_comment_history',comment_id=uid('deleted'),history_no=1,action='delete',body='Demo: an obsolete question removed by its author.',actor_id=uid('soren'),created_at=date(10))
        insert('report_comments',id=uid('deleted-reply'),report_id=rid(key),sequence_no=sequence+2,revision_no=rev,author_id=uid('mira'),reply_to_id=uid('deleted'),body='The parent was removed; this reply remains in the discussion.',created_at=date(10))
    if key==('bytes','Kani'):
        insert('report_comments',id=uid('edited'),report_id=rid(key),sequence_no=sequence+1,revision_no=rev,author_id=uid('nora'),body='Edited: the range endpoint equal to the buffer length is included.',edit_version=2,created_at=date(9),edited_at=date(10))
        insert('report_comment_history',comment_id=uid('edited'),history_no=1,action='edit',body='Is the upper endpoint covered?',actor_id=uid('nora'),created_at=date(10))
        for name in ['emil','soren']:insert('report_comment_votes',comment_id=uid('edited'),user_id=uid(name),value=1,updated_at=date(10))
insert('audit_events',id=uid('reports-seed-audit'),action='staging_demo_seed',target_id='staging-demo-reports-v1',reason='User-requested synthetic staging data based on the original Sites mock.',created_at=date(10))
Path('fixtures/staging-demo.sql').write_text('\n'.join(Q)+'\n')
print(f'{len(groups)} reports; {len(claims)} claims; {len(Q)} additive statements')
