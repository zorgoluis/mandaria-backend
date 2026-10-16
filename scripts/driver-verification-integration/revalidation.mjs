import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import sharp from 'sharp';
const hash=b=>createHash('sha256').update(b).digest('hex');
export async function revalidate(h){
 const {e,db,A,expect,check,cmd,shot}=h;
 const p=A.page;
 await p.setViewportSize({width:1365,height:900});
 let caseId;
 await check('R-W01-success-real-confirmation',async()=>{
  caseId=(await cmd(A,'/driver/verification-cases',{subjectType:'DRIVER_IDENTITY',subjectId:A.driver})).id;
  await p.goto(e.web+'/verification/cases/'+caseId);
  const section=p.getByRole('heading',{name:'Evidencias privadas'}).locator('..');
  const input=section.getByLabel('Imagen sintética *',{exact:true});
  const button=section.getByRole('button',{name:'Cargar imagen sintética',exact:true});
  const a=await sharp({create:{width:16,height:16,channels:3,background:'#ff0000'}}).png({compressionLevel:0}).toBuffer();
  const b=await sharp({create:{width:16,height:16,channels:3,background:'#0000ff'}}).png({compressionLevel:0}).toBuffer();
  assert.equal(a.length,b.length);assert.notEqual(hash(a),hash(b));
  let release,reached;
  const gate=new Promise(r=>release=r), arrived=new Promise(r=>reached=r);
  const pattern='**/verification-cases/'+caseId+'/uploads/*/complete';
  let held=false;
  const handler=async route=>{if(held)return route.continue(); held=true; const response=await route.fetch(); assert.equal(response.status(),200);reached();await gate;await route.fulfill({response});};
  await p.route(pattern,handler);
  const select=async bytes=>input.evaluate((el,data)=>{const dt=new DataTransfer();dt.items.add(new File([new Uint8Array(data)],'same.png',{type:'image/png',lastModified:1700000000000}));el.files=dt.files;el.dispatchEvent(new Event('change',{bubbles:true}));},Array.from(bytes));
  try{
   await select(a);await button.click();await arrived;
   await select(b);release();await expect(button).toBeEnabled();
   await expect(section.getByText(/selección posterior sigue pendiente/)).toBeVisible();
   const selected=await input.evaluate(async el=>({name:el.files[0].name,size:el.files[0].size,date:el.files[0].lastModified,bytes:Array.from(new Uint8Array(await el.files[0].arrayBuffer()))}));
   assert.equal(hash(Buffer.from(selected.bytes)),hash(b));
   let rows=await db.verificationAttachment.findMany({where:{caseId}});assert.equal(rows.length,1);assert.equal(rows[0].sourceHash,hash(a));assert.equal(rows[0].status,'VALIDATED');
   assert.equal(hash(e.objects.get(rows[0].quarantineKey)),hash(a));
   await shot(A,'W01-B-pending');
   await button.click();await expect.poll(async()=>db.verificationAttachment.count({where:{caseId,status:'VALIDATED'}})).toBe(2);await expect(button).toBeEnabled();
   rows=await db.verificationAttachment.findMany({where:{caseId}});
   const rb=rows.find(r=>r.sourceHash===hash(b));assert(rb);assert.equal(hash(e.objects.get(rb.quarantineKey)),hash(b));assert.equal(hash(e.objects.get(rb.objectKey)),rb.hash);
   e.report.w01={sameName:true,sameSize:a.length,sameLastModified:1700000000000,sourceHashes:[hash(a),hash(b)],rows:rows.map(r=>({id:r.id,caseId:r.caseId,status:r.status,sourceHash:r.sourceHash,hash:r.hash})),preview:'No selection preview exists in product; selected File bytes checked; server evidence preview remains separate.'};
  }finally{release();await p.unroute(pattern,handler);}
 });
 await check('R-W01-failed-A-preserves-B',async()=>{
  assert(caseId);await p.goto(e.web+'/verification/cases/'+caseId);
  const input=p.getByLabel('Imagen sintética *',{exact:true});const button=p.getByRole('button',{name:'Cargar imagen sintética',exact:true});
  const b=await sharp({create:{width:18,height:18,channels:3,background:'#00ff00'}}).png().toBuffer();
  let release,reached;const gate=new Promise(r=>release=r),arrived=new Promise(r=>reached=r);
  const pattern='**/verification-cases/'+caseId+'/uploads/*/complete';
  const handler=async route=>{const response=await route.fetch();assert(response.status()>=400);reached();await gate;await route.fulfill({response});};
  await p.route(pattern,handler);
  try{
   await input.setInputFiles({name:'invalid-A.png',mimeType:'image/png',buffer:Buffer.from('not an image')});await button.click();await arrived;
   await input.setInputFiles({name:'valid-B.png',mimeType:'image/png',buffer:b});release();await expect(button).toBeEnabled();await expect(p.getByText(/Carga de invalid-A.png:/)).toBeVisible();
   assert.equal(await input.evaluate(el=>el.files[0].name),'valid-B.png');
   assert.equal(await db.verificationAttachment.count({where:{caseId,status:'VALIDATED'}}),2);
  }finally{release();await p.unroute(pattern,handler);}
  await button.click();await expect.poll(async()=>db.verificationAttachment.count({where:{caseId,status:'VALIDATED'}})).toBe(3);await expect(button).toBeEnabled();await shot(A,'W01-failure-B-explicit');
 });
 await check('R-ABSENT-real-modal',async()=>{
  await p.goto(e.web+'/driver/onboarding');
  const marker={actor:A.id,key:randomUUID(),operation:'CREATE_VEHICLE',target:'SELF'};
  const before={cases:await db.verificationCase.count(),files:await db.verificationAttachment.count(),vehicles:await db.vehicle.count()};
  // Preparation models a persisted client marker with no server command. No receipt is fabricated.
  await p.evaluate(({marker,api})=>localStorage.setItem('mandaria.verification.pending:'+api,JSON.stringify([marker])),{marker,api:e.api.replace('/api/v1','')});
  await p.reload();await p.getByRole('button',{name:'Consultar intento',exact:true}).click();await expect(p.getByText(/ABSENT no demuestra fracaso/)).toBeVisible();
  await p.getByRole('button',{name:'Cerrar intento técnico',exact:true}).click();await expect(p.getByText(/Este cierre no retira el expediente/)).toBeVisible();
  await p.getByRole('button',{name:'Confirmar cierre técnico',exact:true}).click();
  await expect.poll(async()=>db.verificationCommand.findUnique({where:{actorId_key:{actorId:A.id,key:marker.key}}})).not.toBeNull();
  const row=await db.verificationCommand.findUniqueOrThrow({where:{actorId_key:{actorId:A.id,key:marker.key}}});assert.equal(row.state,'CLOSED_NO_EFFECTS');
  await p.reload();await expect(p.getByRole('heading',{name:'Pendiente de reconciliación'})).toHaveCount(0);
  assert.deepEqual({cases:await db.verificationCase.count(),files:await db.verificationAttachment.count(),vehicles:await db.vehicle.count()},before);await shot(A,'ABSENT-closed');
 });
}

export async function finalPending(h){
 const {e,db,A,admin,owned,expect,check,cmd,ok,shot,secrets}=h;const p=A.page;
 await check('R-independent-positive-take-browser',async()=>{
  assert.equal((await db.verificationPolicy.findUniqueOrThrow({where:{id:1}})).enabled,true);
  const client=await db.integrationClient.findFirstOrThrow({where:{code:'DOC_SYNTH'}});
  const credential=await ok(admin,'/admin/integrations/'+client.id+'/credentials','POST',{scopes:['deliveries:create','deliveries:read','quotes:create','quotes:accept']});secrets.add(credential.clientSecret);
  const auth=await ok(null,'/integrations/token','POST',{clientId:credential.clientId,clientSecret:credential.clientSecret});secrets.add(auth.accessToken);const b2b={token:auth.accessToken};
  const stop=(type,sequence,d)=>({type,sequence,address:'Calle sintética',latitude:18+d,longitude:-95+d,contactName:'Contacto sintético',contactPhone:'0000000000'});
  const req=await cmd(b2b,'/delivery-requests',{stops:[stop('PICKUP',1,.02),stop('DROPOFF',2,.05)],packages:[{category:'FOOD',description:'Sintético revalidación',quantity:1}],financialContext:{goodsPaymentMode:'PREPAID',currency:'MXN'}});
  const q=await ok(b2b,'/delivery-requests/'+req.publicId+'/quotes','POST');await ok(b2b,'/delivery-quotes/'+q.publicId+'/accept','POST');
  const d=await db.dispatch.findFirstOrThrow({where:{deliveryRequest:{publicId:req.publicId}}});
  const {tsImport}=await import('tsx/esm/api');const {pathToFileURL}=await import('node:url');const {backend}=await import('./environment.mjs');
  const {fundForAward}=await tsImport(pathToFileURL(backend+'/test/support/credits.ts').href,import.meta.url);await fundForAward(db,d.id,{driverId:A.driver});
  const before=await db.creditLedgerEntry.count();
  await p.goto(e.web+'/driver/services/'+d.id);await p.getByRole('button',{name:'TOMAR SERVICIO',exact:true}).click();await p.getByLabel('Vehículo',{exact:true}).selectOption(owned.v.id);
  const response=p.waitForResponse(r=>r.url().endsWith('/driver/dispatches/'+d.id+'/take')&&r.request().method()==='POST');
  await p.getByRole('button',{name:'CONFIRMAR',exact:true}).click();assert.equal((await response).status(),200);
  await p.waitForURL(/driver\/my-service/);await p.reload();
  const assignments=await db.deliveryAssignment.findMany({where:{dispatchId:d.id}});assert.equal(assignments.length,1);assert.equal(assignments[0].driverId,A.driver);assert.equal(assignments[0].vehicleId,owned.v.id);assert.equal(assignments[0].status,'ACTIVE');
  const after=await db.creditLedgerEntry.count();assert.equal(after,before+1);await p.reload();assert.equal(await db.creditLedgerEntry.count(),after);assert.equal(await db.deliveryAssignment.count({where:{dispatchId:d.id}}),1);
  const final=await db.dispatch.findUniqueOrThrow({where:{id:d.id},include:{searchRounds:true}});assert.equal(final.searchAttempt,d.searchAttempt);assert.equal(final.searchMaxAttempts,d.searchMaxAttempts);assert.equal(final.searchRounds.length,0);
  await expect(p.getByRole('heading',{name:'Servicio actual',exact:true})).toBeVisible();
  await expect(p.getByRole('region',{name:'Servicio actual'})).toContainText(owned.v.identifier);
  e.report.independentTake={dispatchId:d.id,driverId:A.driver,vehicleId:owned.v.id,assignmentId:assignments[0].id,ledgerDelta:after-before};await shot(A,'independent-taken');
 });
 await check('R-terms-effective-V2-browser',async()=>{
  await p.goto(e.web+'/driver/onboarding');
  await expect(p.getByRole('region',{name:'Texto completo de los términos'})).toBeVisible();
  const old=await db.verificationTerms.findUniqueOrThrow({where:{version:'DRIVER-LOCAL-TEST-1'}});
  const receipts=await db.verificationAcceptance.findMany({where:{userId:A.id,version:old.version}});assert.equal(receipts.length,1);
  const version='DRIVER-LOCAL-TEST-2-INTEGRATION';const text=old.text+'\nVERSIÓN V2 SINTÉTICA DE INTEGRACIÓN. SIN VIGENCIA CONTRACTUAL.';const digest=hash(text);
  // Fixture publication, not a product endpoint: append immutable test terms and switch isolated policy atomically.
  await db.$transaction(async tx=>{await tx.verificationTerms.create({data:{version,scope:'DRIVER',environment:'LOCAL_TEST',text,hash:digest}});await tx.verificationPolicy.update({where:{id:1},data:{driverTermsVersion:version,revision:{increment:1}}});});
  await p.getByRole('checkbox').first().check();
  const rejected=p.waitForResponse(r=>r.url().endsWith('/verification-terms/accept')&&r.request().method()==='POST');await p.getByRole('button',{name:'Aceptar personalmente (prueba)',exact:true}).click();const response=await rejected;assert.equal(response.status(),409);assert.equal((await response.json()).code,'TERMS_VERSION_CONFLICT');
  // Wait for the real client's rejection refresh/marker cleanup before navigating.
  await expect(p.getByRole('heading',{name:'Pendiente de reconciliación'})).toHaveCount(0);
  await p.reload();await expect(p.getByRole('region',{name:'Texto completo de los términos'})).toContainText('VERSIÓN V2');await expect(p.getByRole('checkbox').first()).not.toBeChecked();await p.getByRole('checkbox').first().check();await p.getByRole('button',{name:'Aceptar personalmente (prueba)',exact:true}).click();
  await expect.poll(()=>db.verificationAcceptance.count({where:{userId:A.id,version}})).toBe(1);const receipt=await db.verificationAcceptance.findFirstOrThrow({where:{userId:A.id,version}});assert.equal(receipt.scope,'DRIVER');
  assert.deepEqual(await db.verificationAcceptance.findMany({where:{userId:A.id,version:old.version}}),receipts);assert.deepEqual(await db.verificationTerms.findUniqueOrThrow({where:{version:old.version}}),old);
  assert.equal((await db.verificationTerms.findUniqueOrThrow({where:{version}})).hash,digest);e.report.termsV2={version,hash:digest,receiptId:receipt.id,actor:A.id,scope:receipt.scope,publication:'SQL fixture only in dedicated temporary cluster; no publication endpoint'};await shot(A,'terms-V2');
 });
}
