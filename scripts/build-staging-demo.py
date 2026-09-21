"""Generate additive, repeatable staging fixtures; never a schema migration."""
import json, uuid
from pathlib import Path
D=json.loads(Path('fixtures/staging-demo.json').read_text())
Q=[]
def val(x):
    if x is None:return 'NULL'
    if isinstance(x,int):return str(x)
    return "'"+str(x).replace("'","''")+"'"
def insert(table, **values):
    Q.append('INSERT OR IGNORE INTO '+table+'('+','.join(values)+') VALUES('+','.join(v[1] if isinstance(v,tuple) else val(v) for v in values.values())+');')
def expr(s):return ('sql',s)
def uid(s):return str(uuid.uuid5(uuid.NAMESPACE_URL,'https://proofs.rs/staging-demo/v1/'+s))
def date(n):return f'2026-09-{min(28,10+n):02d}T10:00:00.000Z'
def cid(n):return expr("(SELECT id FROM claims WHERE create_key="+val('staging-demo-v1-'+str(n))+")")
def rel(c):return expr("(SELECT r.id FROM releases r JOIN crates c ON c.id=r.crate_id WHERE c.name="+val(c['name'])+" AND r.version="+val(c['v']+'-demo.1')+")")
for i,name in enumerate(['mira','nora','emil','soren']):
    insert('users',id=uid(name),github_id=-91001-i,username='demo_'+name,role='user',status='active',accepted_terms_version='2026-09-20',terms_accepted_at=date(0),created_at=date(0))
    insert('notification_preferences',user_id=uid(name),replies=0,claim_comments=0)
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
claims=D['claims']+[dict(D['claims'][1],id=104,title='Minimal metadata with empty optional text',comments=[],revision=1,description='')]
for idx,c in enumerate(claims):
    created=date(1+idx//2)
    insert('claims',create_key='staging-demo-v1-'+str(c['id']),api_item_id=uid(c['crate']+'/'+c['api']),property='no_ub' if c['property']=='No undefined behavior' else 'panic_contract',author_id=uid(c['author']),withdrawn_at=date(15) if c['id']==35 else None,created_at=created,updated_at=date(15) if c['revision']>1 else created)
    t=next(t for t in D['tools'] if t['name']==c['method'].split(' · ')[0])
    for revision in range(1,c['revision']+1):
        insert('claim_revisions',claim_id=cid(c['id']),revision_no=revision,title=c['title']+(' (initial scope)' if revision<c['revision'] else ''),precondition=c['condition']+'\n'+c['formula'],explanation='' if c['id']==104 else '[Demo fixture — not an actual verification result.]\n'+c['description'],trusted_assumptions='' if c['id']==104 else 'Illustrative tool implementation, compiler and library models.',tool_version_id=uid(t['id']+t['versions'][0]),environment=c['scope'],evidence_url='https://example.com/proofs-rs-demo/'+str(c['id']),limitations='Synthetic staging data. No proof was run. '+c['scope'],created_at=created if revision==1 else date(15))
    for j,cm in enumerate(c['comments']):
        name,_,body,*_=cm
        parent=uid('comment/'+str(c['id'])+'/'+str(j-1)) if j and (name==c['author'] or c['id']==17 and j==2) else None
        insert('comments',id=uid('comment/'+str(c['id'])+'/'+str(j)),claim_id=cid(c['id']),sequence_no=j+1,revision_no=1 if j<2 else c['revision'],author_id=uid(name),reply_to_id=parent,body=body,created_at=date(3+j+idx//2))
    for name in ['mira','nora','emil','soren']:
        if name!=c['author'] and c['id']%3!=2:
            insert('accepts',claim_id=cid(c['id']),revision_no=c['revision'],user_id=uid(name),created_at=date(16))
# A deleted parent with a visible reply, and retained private history.
insert('comments',id=uid('deleted'),claim_id=cid(17),sequence_no=5,revision_no=2,author_id=uid('soren'),body=None,created_at=date(12),deleted_at=date(14),edit_version=2)
insert('comment_history',comment_id=uid('deleted'),history_no=1,action='delete',body='Demo: an obsolete question removed by its author.',actor_id=uid('soren'),created_at=date(14))
insert('comments',id=uid('deleted-reply'),claim_id=cid(17),sequence_no=6,revision_no=2,author_id=uid('mira'),reply_to_id=uid('deleted'),body='The parent was removed; this reply remains in the discussion.',created_at=date(13))
insert('comments',id=uid('edited'),claim_id=cid(26),sequence_no=3,revision_no=2,author_id=uid('nora'),body='Edited: the range endpoint equal to the buffer length is included.',edit_version=2,created_at=date(12),edited_at=date(13))
insert('comment_history',comment_id=uid('edited'),history_no=1,action='edit',body='Is the upper endpoint covered?',actor_id=uid('nora'),created_at=date(13))
for name in ['emil','soren']:insert('comment_votes',comment_id=uid('edited'),user_id=uid(name),value=1,updated_at=date(14))
insert('comment_votes',comment_id=uid('comment/17/0'),user_id=uid('emil'),value=1,updated_at=date(14))
insert('audit_events',id=uid('seed-audit'),action='staging_demo_seed',target_id='staging-demo-v1',reason='User-requested synthetic staging data based on the original Sites mock.',created_at=date(11))
Path('fixtures/staging-demo.sql').write_text('\n'.join(Q)+'\n')
print(f'{len(claims)} claims; {len(Q)} additive statements')
