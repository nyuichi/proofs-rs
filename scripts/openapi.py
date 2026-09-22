"""Generate the public contract; route coverage is checked by the test suite."""
import json,re,sqlite3
from pathlib import Path
S=lambda max=10000,**kw:dict(type='string',maxLength=max,**kw)
I={'type':'integer','minimum':1}; B={'type':'boolean'}
def obj(p,required=None):return dict(type='object',properties=p,required=list(p) if required is None else required)
def ref(n):return {'$ref':'#/components/schemas/'+n}
def arr(v):return {'type':'array','items':v}
def listing(v):return obj({'items':arr(v),'next_cursor':{'type':['string','null'],'description':'Opaque keyset cursor; pass unchanged. Null means no more results.'}})
sc={}
db=sqlite3.connect(':memory:')
for p in sorted(Path('migrations').glob('*.sql')):db.executescript(p.read_text())
for table in ['crates','releases','api_items','tools','tool_versions','report_comments']:
 fields={}
 for _,name,typ,notnull,default,pk in db.execute('pragma table_info('+table+')'):
  typ='integer' if typ=='INTEGER' else 'string'
  fields[name]={'type':typ if notnull or pk else [typ,'null']}
 sc[table]=obj(fields)
sc['Error']=obj({'error':S(),'message':S(),'request_id':S()},['error'])
sc['Ok']=obj({'ok':{'const':True}})
sc['ClaimInput']=obj({'id':S(format='uuid',description='Only for an existing claim in a report revision. Omit for new claims.'),'api_item_id':S(200,minLength=1),'property':{'enum':['no_ub','panic_contract']},'title':S(1000,description='Optional. Empty or omitted titles are generated from the property, API path and report tool/version.'),'precondition':S(description='Required for panic_contract and unsafe APIs.'),'explanation':S(),'trusted_assumptions':S(),'evidence_url':S(1000,description='HTTP(S) URL or empty. At least the shared or individual evidence URL is required for each claim.'),'limitations':S()},['api_item_id','property'])
sc['ReportInput']=obj({'crate':S(100,minLength=1),'version':S(100,minLength=1),'title':S(1000,minLength=1),'tool_version_id':S(200,minLength=1),'explanation':S(),'trusted_assumptions':S(),'environment':S(),'evidence_url':S(1000),'limitations':S(),'claims':dict(arr(ref('ClaimInput')),minItems=1,maxItems=100)},['crate','version','title','tool_version_id','claims'])
sc['RevisionInput']={'allOf':[ref('ReportInput'),obj({'expected_revision':I})]}
sc['ValidationInput']={'allOf':[ref('ReportInput'),obj({'report_id':I},[])]}
sc['NormalizedClaimInput']=obj({**sc['ClaimInput']['properties'],'id':{'type':['string','null'],'format':'uuid'},'display_path':S(),'is_unsafe':{'type':'integer'}})
sc['ValidationResult']=obj({**sc['ReportInput']['properties'],'claims':arr(ref('NormalizedClaimInput')),'release_id':I,'tool':S(),'tool_version':S(),'changes':obj({'added':{'type':'integer'},'retained':arr(S()),'removed':arr(S())})})
reportFields={k:S() for k in ['title','explanation','trusted_assumptions','environment','evidence_url','limitations','tool_version_id','created_at','updated_at','crate','version','tool','tool_version','visibility']}
reportFields.update({k:{'type':'integer'} for k in ['id','release_id','revision_no','latest_revision_no','star_count','comment_count','claim_count','author_karma','yanked']})
reportFields.update({k:{'type':['string','null']} for k in ['author_id','username','withdrawn_at']})
sc['Report']=obj(reportFields)
claimFields={k:S() for k in ['id','api_item_id','property','created_at','title','precondition','explanation','trusted_assumptions','evidence_url','limitations','display_path','signature','upstream_url','report_title','shared_explanation','shared_trusted_assumptions','shared_evidence_url','shared_limitations','environment','tool_version_id','crate','version','tool','tool_version','visibility']}
claimFields.update({k:{'type':'integer'} for k in ['report_id','report_revision','latest_report_revision','position','star_count','report_star_count','report_comment_count','author_karma','is_unsafe','in_current_report']})
claimFields.update({k:{'type':['string','null']} for k in ['author_id','username','withdrawn_at']})
sc['Claim']=obj(claimFields)
sc['ClaimDetail']={'allOf':[ref('Claim'),obj({'my_star':B})]}
sc['ReportDetail']={'allOf':[ref('Report'),obj({'my_star':B,'claims':arr(ref('ClaimDetail'))})]}
sc['Comment']=obj({**{k:v for k,v in sc['report_comments']['properties'].items() if k!='visibility'},'username':{'type':['string','null']},'score':{'type':'integer'},'my_vote':{'type':['integer','null']},'reply_count':{'type':'integer'},'hidden':B})
sc['Token']=obj({'id':S(format='uuid'),'created_at':S(format='date-time'),'last_used_at':{'type':['string','null'],'format':'date-time'},'expires_at':S(format='date-time')})
sc['User']=obj({'id':S(),'github_id':I,'username':S(),'role':S(),'status':S(),'accepted_terms_version':S(),'terms_accepted_at':S(format='date-time')})
sc['Import']=obj({'id':S(),'status':{'enum':['pending','running','retry','ready','failed']},'error_code':{'type':['string','null']},'crate':S(),'version':S()},['id','status'])
paths={}
def add(path,method,summary,body=None,out=None,security=None,description='',status=200,queries=None,idem=False,form=False):
 params=[dict(name=x,**{'in':'path'},required=True,schema=S()) for x in re.findall(r'{(\w+)}',path)]
 for name,schema,required in queries or []:params.append(dict(name=name,**{'in':'query'},required=required,schema=schema))
 if idem:params.append(dict(name='Idempotency-Key',**{'in':'header'},required=True,schema=S(100,minLength=16,pattern='^[a-zA-Z0-9_-]{16,100}$'),description='Reuse the same key and identical JSON body on retry. A different body with the same key returns 409.'))
 if security is None:security=[{}, {'session':[]},{'bearer':[]}] if method=='get' else [{'session':[],'csrf':[]},{'bearer':[]}]
 if method!='get' and any('session' in x for x in security):params.append(dict(name='Origin',**{'in':'header'},required=False,schema=S(),description='Required for browser-session writes; must equal this service origin.'))
 responses={str(status):dict(description='Success',content={'application/json':{'schema':out or ref('Ok')}})}
 for code,desc in [(400,'Invalid input'),(401,'Authentication required or token invalid/expired'),(403,'Forbidden, insufficient scope, suspended account, or invalid Origin/CSRF'),(404,'Resource not found'),(409,'Conflict, stale revision, or idempotency mismatch'),(413,'Body exceeds 128 KiB'),(415,'Unsupported content type'),(428,'Terms changed: sign in in the browser and accept the current terms'),(429,'Rate limit exceeded'),(500,'Internal error'),(503,'Service unavailable')]:responses[str(code)]=dict(description=desc,content={'application/json':{'schema':ref('Error')}})
 tag='Authentication' if path.startswith('/auth') else ('Tokens' if '/tokens' in path else ('Reports' if '/reports' in path else ('Claims' if '/claims' in path else ('Comments' if '/comments' in path else ('Imports' if '/imports' in path or '/prepare' in path else 'Registry')))))
 op=dict(operationId=method+'_'+re.sub(r'[^a-zA-Z0-9]+','_',path).strip('_'),summary=summary,tags=[tag],description=description,security=security,parameters=params,responses=responses)
 if body:op['requestBody']=dict(required=True,content={mime:{'schema':body} for mime in (['application/json','application/x-www-form-urlencoded'] if form else ['application/json'])})
 paths.setdefault(path,{})[method]=op
session=[{'session':[],'csrf':[]}];sessionRead=[{'session':[]}]
P='/api/v1';cursor=[('cursor',S(description='Opaque next_cursor from the preceding response. Page size is 30.'),False)]
add(P+'/health','get','Service health',out=obj({'ok':B,'environment':S()}))
add(P+'/config','get','Public service configuration',out=obj({'environment':S(),'oauth_configured':B,'email_disabled':B,'email_configured':B,'terms_version':S()}))
add(P+'/terms/current','get','Current terms',out=obj({'version':S(),'url':S(),'summary':S(),'requires_agreement':B}))
add(P+'/me','get','Current account',out={'oneOf':[obj({'user':{'type':'null'}}),obj({'user':ref('User'),'csrf':S(),'email':{'oneOf':[{'type':'null'},obj({'address':{'type':['string','null']},'delivery_status':S()})]},'delayed_notifications':{'type':'integer'},'karma':{'type':'integer'},'terms_required':B})]})
add(P+'/me/terms-acceptance','post','Accept current terms',obj({'version':S()}),security=session)
add(P+'/me/notification-preferences','get','Email notification preferences',out=obj({'replies':{'enum':[0,1]},'report_comments':{'enum':[0,1]}}),security=sessionRead)
add(P+'/me/notification-preferences','patch','Update email notification preferences',obj({'replies':B,'report_comments':B}),security=session)
add(P+'/notifications/unsubscribe','post','Unsubscribe with signed link',obj({'user':S(),'signature':S()}),security=[],description='Requires the signed unsubscribe value and a same-origin Origin header.')
add(P+'/home','get','Recent reports and discussion',out=obj({'reports':arr(ref('Report')),'discussion':arr(obj({'id':S(),'report_id':I,'sequence_no':I,'revision_no':I,'body':S(),'created_at':S(),'username':{'type':['string','null']},'author_id':{'type':['string','null']}}))}))
add(P+'/crates','get','Search crates with claims',out={'allOf':[listing({'allOf':[ref('crates'),obj({'api_count':{'type':'integer','description':'Distinct API paths across versions with public, nonwithdrawn reports.'},'report_count':{'type':'integer'},'claim_count':{'type':'integer'},'updated_at':S(format='date-time')})]}),obj({'total_count':{'type':'integer','description':'Total crates with public, nonwithdrawn reports, independent of query and cursor.'},'matching_count':{'type':'integer','description':'Total matches for q, independent of cursor.'}})]},queries=cursor+[('q',S(),False)])
add(P+'/crates/{name}/releases','get','List releases with claims',out=obj({'items':arr(ref('releases')),'default_version':S(),'description':S()},['items','description']))
add(P+'/crates/{name}/{version}/apis','get','List imported public functions and inherent methods',out=listing({'allOf':[ref('api_items'),obj({'no_ub_count':{'type':'integer'},'panic_count':{'type':'integer'}})]}),queries=cursor+[('q',S(),False)])
add(P+'/crates/{name}/{version}/reports','get','List reports for a crate version',out=listing(ref('Report')),queries=cursor,description='Current public, nonwithdrawn reports for the exact selected version, newest first.')
add(P+'/apis/{id}','get','Get imported API',out={'allOf':[ref('api_items'),obj({'crate':S(),'version':S(),'yanked':{'type':'integer'},'target':S(),'features_json':S(),'rustdoc_format':I})]})
add(P+'/resolve-api','get','Resolve a crate API path to its ID',out=obj({'id':S()}),queries=[(x,S(),True) for x in ['crate','version','path']])
add(P+'/apis/{id}/claims','get','List latest claims for an API',out=listing(ref('Claim')),queries=cursor)
add(P+'/claims/{id}','get','Read a claim and its shared report context',out=ref('ClaimDetail'),queries=[('report_revision',I,False)],description='Default: last report revision containing this claim. in_current_report is 0 if removed. The permanent ID and stars survive removal and revision. Comments are only available on the report.')
add(P+'/reports','get','List current reports',out=listing(ref('Report')),queries=cursor)
add(P+'/reports','post','Publish a report and all its claims atomically',ref('ReportInput'),obj({'id':I}),status=201,idem=True,description='20 report publications or revisions per user per UTC day. No drafts. All claims must target this exact crate version. Prepare the catalogue first. Repeating an API/property with different scope is allowed. At most 100 claims, subject to the 128 KiB total request limit.')
add(P+'/reports/validate','post','Validate without saving and preview generated titles and membership changes',ref('ValidationInput'),out=ref('ValidationResult'),description='Include report_id when previewing a revision; only its author may do so. Returns indexed claim validation errors. New claim IDs are null in the preview; omit them when publishing.')
add(P+'/reports/{id}','get','Read current report and all claims',out=ref('ReportDetail'))
add(P+'/reports/{id}/revisions','get','List report revisions',out=listing(obj({'revision_no':I,'created_at':S()})),queries=cursor)
add(P+'/reports/{id}/revisions/{n}','get','Read a specific immutable report revision',out=ref('ReportDetail'))
add(P+'/reports/{id}/revisions','post','Publish a complete replacement report revision atomically',ref('RevisionInput'),obj({'id':I,'revision_no':I}),status=201,idem=True,description='Author only. expected_revision must match. Include IDs for retained claims; omit IDs for new claims. Omitted existing claims are removed from the new revision but retain history, permanent URLs and stars. API/property and report crate/version are immutable. Withdrawn reports cannot be revised.')
add(P+'/reports/{id}/withdrawal','put','Withdraw a report; retain public history and discussion',security=session)
for kind in ['report','claim']:
 add(P+'/'+kind+'s/{id}/stars','get','List people who starred this '+kind,out=listing(obj({'id':S(),'username':S(),'created_at':S(format='date-time')})),queries=cursor,description='Public. Newest stars first, ordered by user ID for ties. Uses the same visibility rules as the target, including withdrawn reports and removed claims.')
 for method in ['put','delete']:add(P+'/'+kind+'s/{id}/star',method,'Star '+kind if method=='put' else 'Unstar '+kind,security=session,description='Idempotent. Stars are independent of revisions. Self-stars are allowed; they do not add karma. Only report stars contribute to karma.')
 add(P+'/me/starred-'+kind+'s','get','List your starred '+kind+'s',out=listing({'allOf':[ref(kind.title()),obj({'starred_at':S()})]}),queries=cursor,security=sessionRead)
add(P+'/reports/{id}/comments','get','List root comments or replies',out=listing(ref('Comment')),queries=cursor+[('parent_id',S(),False)],description='Omit parent_id for roots. Deleted or hidden comments remain as tombstones; body is null.')
add(P+'/comments/{id}','get','Get comment and ancestor IDs',out={'allOf':[ref('Comment'),obj({'ancestors':arr(S())})]})
add(P+'/reports/{id}/comments','post','Post a comment or reply',obj({'body':S(5000,minLength=1),'revision_no':I,'reply_to_id':S(100)},['body','revision_no']),obj({'id':S()}),security=session,status=201,idem=True,description='100 new comments per user per UTC day.')
add(P+'/comments/{id}','patch','Edit your comment',obj({'body':S(5000,minLength=1),'edit_version':I}),obj({'ok':B,'edit_version':I}),security=session)
add(P+'/comments/{id}','delete','Delete your comment',obj({'edit_version':I}),obj({'ok':B,'edit_version':I}),security=session,description='Requires JSON body. Leaves a discussion tombstone; history is private.')
for method in ['put','delete']:
 add(P+'/comments/{id}/vote',method,'Set comment vote' if method=='put' else 'Remove comment vote',obj({'value':{'enum':[-1,1]}}) if method=='put' else None,security=session)
add(P+'/users/{id}','get','Get public account activity profile',out=obj({'id':S(),'username':S(),'created_at':S(),'karma':{'type':'integer'},'algorithm_version':S()}))
for prefix in ['/users/{id}','/me']:
 for suffix,schema in [('reports','Report'),('comments','Comment')]:add(P+prefix+'/'+suffix,'get','List user '+suffix,out=listing(ref(schema)),queries=cursor,security=([{'session':[]},{'bearer':[]}] if suffix=='reports' else sessionRead) if prefix=='/me' else None,description='Deleted comments are excluded from activity.')
add(P+'/tools','get','List registered tools and versions',out=obj({'items':arr(ref('tools')),'versions':arr(ref('tool_versions'))}))
add(P+'/tools/{slug}','get','Get registered tool',out={'allOf':[ref('tools'),obj({'versions':arr(ref('tool_versions'))})]})
add(P+'/tools/{slug}/reports','get','List reports using a tool',out=listing(ref('Report')),queries=cursor)
add(P+'/publish/prepare','post','Prepare exact crate version',obj({'crate':S(64,minLength=1),'version':S(100,minLength=1)}),obj({'status':{'const':'ready'},'crate':S(),'version':S()}),description='Returns 200 when cached, otherwise 202 with an import job ID. Poll GET /imports/{id}. 5 new imports per user per UTC day, 50 per IP. No proof execution.')
paths[P+'/publish/prepare']['post']['responses']['202']={'description':'Import pending or running','content':{'application/json':{'schema':ref('Import')}}}
add(P+'/imports/{id}','get','Check import status',out=ref('Import'),security=[{'session':[]},{'bearer':[]}])
add('/auth/device/code','post','Start CLI browser authorization',obj({'client_id':{'const':'proofs-cli'},'scope':{'const':'publish'}},['client_id']),obj({'device_code':S(),'user_code':S(),'verification_uri':S(format='uri'),'verification_uri_complete':S(format='uri'),'expires_in':I,'interval':I}),security=[],form=True,description='Device Flow with a fixed public client. Request expires in 600 seconds; initial poll interval 5 seconds. 30 starts per IP per UTC day. Display the user_code in the terminal before opening verification_uri_complete.')
add('/auth/device/token','post','Poll authorization and exchange once',obj({'client_id':{'const':'proofs-cli'},'device_code':S(200),'grant_type':{'const':'urn:ietf:params:oauth:grant-type:device_code'}}),obj({'access_token':S(),'token_type':{'const':'Bearer'},'scope':{'const':'publish'},'expires_in':I,'token_id':S(format='uuid')}),security=[],form=True,description='400 authorization_pending: keep polling. 400 slow_down: increase interval by 5 seconds (server caps interval at 60 seconds). expired_token, access_denied, invalid_grant: stop. 429: stop or retry later. Token expires in 90 days; no refresh token. Exchange succeeds once; if the response is lost, start login again. 10000 polls per IP per UTC day.')
for op in ['inspect','approve']:
 add('/auth/device/'+op,'post','Inspect device request' if op=='inspect' else 'Authorize device request',obj({'user_code':S(20)}),obj({'state':{'enum':['pending','approved','denied','consumed']},'expires_at':S()}) if op=='inspect' else None,security=session,description='Browser only. Requires current terms. 100 code inspections/approvals per IP per UTC day.')
add(P+'/me/tokens','get','List your unexpired, unrevoked tokens',out=obj({'items':arr(ref('Token'))}),security=sessionRead,description='UUID is a public management identifier, never the secret token. Last used is updated at most once per hour. No token names are stored.')
add(P+'/me/tokens/{id}','delete','Revoke your token',security=session,description='Idempotent. Only tokens belonging to the current user can be revoked.')
add(P+'/tokens/revoke','post','Revoke the current CLI token',security=[{'bearer':[]}],description='Use for CLI logout. Works even if terms have changed.')
add('/auth/signup','get','Read pending first-time registration',out=obj({'username':S(),'csrf':S(),'terms_version':S(),'return_to':S()}),security=[],description='Requires the HttpOnly pending signup cookie set after GitHub OAuth. Expires after 10 minutes. Does not create an account.')
add('/auth/signup','post','Confirm first-time registration',obj({'terms_version':S()}),obj({'return_to':S()}),security=[],description='Requires same-origin Origin, pending signup cookie, and X-CSRF-Token returned by GET /auth/signup. Atomically consumes the pending request and creates the account and session. Terms version must still be current. Cannot be used with a CLI bearer token.')
add('/auth/logout','post','Sign out of browser session',security=session)
for path,params in [('/auth/github',[('return_to',S(description='Same-site hash route beginning /#/; invalid values fall back to /#/account.'),False),('switch_account',S(description='Set to 1 to show the GitHub account selector.'),False)]),('/auth/github/callback',[(x,S(),True) for x in ['state','code']])]:
 add(path,'get','Start GitHub sign-in' if path.endswith('github') else 'Complete GitHub sign-in',security=[],queries=params)
 paths[path]['get']['responses']={'302':{'description':'Redirect; session/state cookies may be set'},'400':{'description':'Invalid OAuth state'},'503':{'description':'OAuth not configured'}}
# Match actual accepted Bearer routes rather than advertising unsupported token permissions.
for path,methods in paths.items():
 for method,op in methods.items():
  allowed=method=='get' and (path in [P+'/me',P+'/me/reports'] or re.match(r'^/api/v1/(crates|apis|claims|reports|tools|resolve-api|imports|health|config|terms)(/|$)',path)) or method=='post' and (path in [P+'/reports',P+'/reports/validate',P+'/publish/prepare',P+'/tokens/revoke'] or re.match(r'^/api/v1/reports/[^/]+/revisions$',path))
  if not allowed:op['security']=[x for x in op['security'] if 'bearer' not in x]
  if method=='get':op['parameters']=[x for x in op['parameters'] if x['name']!='Origin']
spec=dict(openapi='3.1.1',info=dict(title='proofs.rs API',version='1.1.0',description='Public registry API and browser-assisted CLI authentication. CLI tokens have publish scope and a 90-day lifetime. Browser writes require same-origin Origin and X-CSRF-Token from GET /api/v1/me. Lists use opaque keyset cursors and 30 items per page unless noted. Non-2xx responses contain an error code. Request bodies are limited to 128 KiB. Current terms must be accepted in the browser before publishing. Local CLI token storage is the responsibility of the client.'),servers=[{'url':'/'}],paths=paths,components=dict(securitySchemes={'session':{'type':'apiKey','in':'cookie','name':'__Host-proofsr_session'},'csrf':{'type':'apiKey','in':'header','name':'X-CSRF-Token'},'bearer':{'type':'http','scheme':'bearer','bearerFormat':'Opaque 256-bit token'}},schemas=sc))
# Reuse error responses so the checked-in document stays readable and small.
common={}
for methods in paths.values():
 for op in methods.values():
  for status,response in list(op['responses'].items()):
   if int(status)>=400 and 'content' in response:
    key='Error'+status
    common[key]=response
    op['responses'][status]={'$ref':'#/components/responses/'+key}
spec['components']['responses']=common
Path('public/openapi.json').write_text(json.dumps(spec,indent=2)+'\n')
print(str(sum(map(len,paths.values())))+' operations documented')
