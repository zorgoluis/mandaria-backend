import {environment,snapshot,web,backend} from './environment.mjs';
import {finalPending} from './revalidation.mjs';
import {randomBytes,randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import argon2 from 'argon2';import sharp from 'sharp';
const e=await environment('documentary-revalidation-take');const {db,expect}=e;let browser;
const password=randomBytes(24).toString('hex');const secrets=new Set([password]);
const ok=async(actor,path,method='GET',body,key)=>{const r=await fetch(e.api+path,{method,headers:{...(actor?.token?{Authorization:'Bearer '+actor.token}:{}),...(body?{'Content-Type':'application/json'}:{}),...(key?{'Idempotency-Key':key}:{})},...(body?{body:JSON.stringify(body)}:{})});const data=await r.json();assert(r.ok,`${method} ${path} ${r.status} ${data.code||''}`);return data;};
const cmd=(actor,path,body)=>ok(actor,path,'POST',body,randomUUID());
try{
 const email='take.synthetic@example.test';await ok(null,'/independent-driver-registrations','POST',{email});const token=e.messages.find(m=>m.to===email).token;
 await ok(null,'/independent-driver-registrations/confirm','POST',{token,password,name:'Persona Sintética'});
 const u=await db.user.findUniqueOrThrow({where:{email},include:{driver:true}});const A={id:u.id,driver:u.driver.id};
 const adminUser=await db.user.create({data:{email:'take-admin.synthetic@example.test',passwordHash:await argon2.hash(password),role:'SUPER_ADMIN',active:true,emailVerifiedAt:new Date()}});
 const admin={id:adminUser.id};for(const [actor,address] of [[A,email],[admin,adminUser.email]]){const auth=await ok(null,'/auth/login','POST',{email:address,password});actor.token=auth.accessToken;secrets.add(auth.accessToken);secrets.add(auth.refreshToken);}
 const terms=await ok(A,'/verification-terms?scope=DRIVER');await cmd(A,'/verification-terms/accept',{scope:'DRIVER',version:terms.version,hash:terms.hash,accepted:true,method:'WEB_CHECKBOX_BUTTON'});
 const png=await sharp({create:{width:20,height:20,channels:3,background:'#aabbcc'}}).png().toBuffer();
 const prepare=async(type,id,data,categories,checks)=>{const c=await cmd(A,'/driver/verification-cases',{subjectType:type,subjectId:id});const base='/verification-cases/'+c.id;let r=await ok(A,base,'PATCH',{expectedVersion:1,data},randomUUID());for(const category of categories){const a=await cmd(A,base+'/uploads',{expectedVersion:r.revision,category});assert.equal((await fetch(a.uploadUrl,{method:'PUT',body:png})).status,200);r=await cmd(A,base+'/uploads/'+a.id+'/complete',{expectedVersion:a.revision});}r=await cmd(A,base+'/submit',{expectedVersion:r.revision});await cmd(admin,'/admin/verification-cases/'+c.id+'/decision',{expectedVersion:r.revision,decision:'APPROVE',checklistVersion:'LOCAL-TEST-1',passedChecks:checks});};
 await prepare('DRIVER_IDENTITY',A.driver,{fullName:'Persona Sintética',contactPhone:'0000000000',operatingCity:'Ciudad sintética',documentType:'INE',license:{issuer:'Sintético',category:'Sintética',expiresAt:new Date(Date.now()+86400000).toISOString(),vehicleTypes:['MOTORCYCLE']}},['FACE_PHOTO','INE_FRONT','INE_BACK','LICENSE'],['IDENTITY_MATCH','LEGIBLE','LICENSE_HOLDER','LICENSE_VALIDITY','LICENSE_CATEGORY']);
 const created=await cmd(A,'/driver/onboarding/vehicles',{identifier:'TAKE-SYNTHETIC',type:'MOTORCYCLE',plate:'SYNTH01'});const v=await db.vehicle.findUniqueOrThrow({where:{id:created.id}});
 await prepare('VEHICLE',v.id,{declaredOwnerName:'Titular Sintético',ownershipEvidenceType:'OWNED',serialNumber:'SERIAL-SYNTHETIC'},['REGISTRATION_CARD','OWNERSHIP_PROOF'],['UNIT_MATCH','LEGIBLE','AUTHORIZED_USE']);
 await cmd(admin,'/admin/verification-policy',{expectedVersion:1,enabled:true});
 const {tsImport}=await import('tsx/esm/api');const {ensureTestCreditPolicies}=await tsImport(pathToFileURL(join(backend,'test/support/credit-policies.ts')).href,import.meta.url);await ensureTestCreditPolicies(db);
 const zone=await ok(admin,'/admin/service-zones','POST',{code:'SYNTH_ZONE',name:'Zona sintética',currency:'MXN',boundary:{type:'Polygon',coordinates:[[[-95,18],[-94.9,18],[-94.9,18.1],[-95,18.1],[-95,18]]]}});await ok(admin,'/admin/service-zones/'+zone.id+'/activate','POST');
 const plan=await ok(admin,'/admin/rate-plans','POST',{serviceZoneId:zone.id,serviceType:'LOCAL_DELIVERY',quoteValidityMinutes:60,bands:[{minDistanceMeters:0,maxDistanceMeters:100000,amount:'60'}]});await ok(admin,'/admin/rate-plans/'+plan.id+'/activate','POST');await ok(admin,'/admin/integrations','POST',{name:'Cliente sintético',code:'DOC_SYNTH'});
 browser=await e.chromium.launch();const ctx=await browser.newContext({viewport:{width:1365,height:900}});const p=await ctx.newPage();A.page=p;ctx.setDefaultTimeout(12000);await ctx.route('**/*',r=>new URL(r.request().url()).hostname==='127.0.0.1'?r.continue():r.abort());
 await p.goto(e.web+'/login?next=onboarding');await p.getByLabel('Correo electrónico',{exact:true}).fill(email);await p.getByLabel('Contraseña',{exact:true}).fill(password);await p.getByRole('button',{name:'Iniciar sesión',exact:true}).click();await p.waitForURL(/onboarding/);
 const check=async(id,fn)=>{if(id!=='R-independent-positive-take-browser')return;try{await fn();e.report.checks.push({id,status:'PASS',detail:'Real browser take and reloaded service region/vehicle; active policy, approved resources, one debit and assignment.'});}catch(err){e.report.checks.push({id,status:'FAIL',detail:err.message.replace(/https?:\/\/[^\s]+/g,'[local URL]').slice(0,1500)});await p.screenshot({path:join(e.output,'failure.png'),fullPage:true});}e.save();};
 e.report.seed='Only SUPER_ADMIN and existing credit-policy/funding fixtures. Independent registration, terms, resources, files, submission and approval via real HTTP as preparation; take via real Web.';
 await finalPending({e,db,A,admin,owned:{v},expect,check,cmd,ok,secrets,shot:async(a,n)=>a.page.screenshot({path:join(e.output,n+'.png'),fullPage:true})});
}finally{await browser?.close();e.report.webUnchanged=JSON.stringify(snapshot(web).files)===JSON.stringify(e.report.versions.web.files);e.report.versions.backendAfter=snapshot(backend);await e.close();process.exitCode=e.report.checks.length!==1||e.report.checks.some(c=>c.status!=='PASS')||!e.report.webUnchanged?1:0;console.log('RESULT '+JSON.stringify({checks:e.report.checks,stopped:e.report.stopped,webUnchanged:e.report.webUnchanged}));}
