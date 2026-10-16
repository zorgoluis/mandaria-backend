import {environment,snapshot,web,backend} from './environment.mjs';
import {finalPending} from './revalidation.mjs';
import {randomBytes} from 'node:crypto';
import {join} from 'node:path';
import assert from 'node:assert/strict';
const e=await environment('documentary-revalidation-terms');const {db,expect}=e;let browser;
try{
 const password=randomBytes(24).toString('hex'), email='terms.synthetic@example.test';
 const call=async(path,body)=>{const r=await fetch(e.api+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});assert(r.ok);return r.json();};
 await call('/independent-driver-registrations',{email});const token=e.messages.find(m=>m.to===email).token;
 await call('/independent-driver-registrations/confirm',{token,password,name:'Persona sintética términos'});
 const actor=await db.user.findUniqueOrThrow({where:{email}});const A={id:actor.id};
 browser=await e.chromium.launch();const ctx=await browser.newContext({viewport:{width:1365,height:900}});const p=await ctx.newPage();A.page=p;ctx.setDefaultTimeout(12000);
 await ctx.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
 await p.goto(e.web+'/login?next=onboarding');await p.getByLabel('Correo electrónico',{exact:true}).fill(email);await p.getByLabel('Contraseña',{exact:true}).fill(password);await p.getByRole('button',{name:'Iniciar sesión',exact:true}).click();await p.waitForURL(/onboarding/);
 await expect(p.getByRole('region',{name:'Texto completo de los términos'})).toBeVisible();await p.getByRole('checkbox').first().check();await p.getByRole('button',{name:'Aceptar personalmente (prueba)',exact:true}).click();
 await expect.poll(()=>db.verificationAcceptance.count({where:{userId:A.id}})).toBe(1);await expect(p.getByRole('heading',{name:'Pendiente de reconciliación'})).toHaveCount(0);
 const check=async(id,fn)=>{if(id!=='R-terms-effective-V2-browser')return;try{await fn();e.report.checks.push({id,status:'PASS',detail:'Real browser V1 rejection, V2 explicit acceptance, immutable V1; waited client refresh before reload.'});}catch(err){e.report.checks.push({id,status:'FAIL',detail:err.message.replace(/https?:\/\/[^\s]+/g,'[local URL]').slice(0,1500)});await p.screenshot({path:join(e.output,'failure.png'),fullPage:true});}e.save();};
 await finalPending({e,db,A,expect,check,shot:async(a,n)=>a.page.screenshot({path:join(e.output,n+'.png'),fullPage:true})});
}finally{
 await browser?.close();e.report.webUnchanged=JSON.stringify(snapshot(web).files)===JSON.stringify(e.report.versions.web.files);e.report.versions.backendAfter=snapshot(backend);await e.close();
 process.exitCode=e.report.checks.length!==1||e.report.checks.some(c=>c.status!=='PASS')||!e.report.webUnchanged?1:0;
 console.log('RESULT '+JSON.stringify({checks:e.report.checks,stopped:e.report.stopped,webUnchanged:e.report.webUnchanged}));
}
