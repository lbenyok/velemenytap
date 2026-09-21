import assert from 'node:assert/strict';

export async function verifyPlatformRoles(db, pass) {
  const owner='74444444-4444-4444-8444-444444444444';
  const mod='75555555-5555-4555-8555-555555555555';
  const other='76666666-6666-4666-8666-666666666666';
  for (const [id,email,confirmed] of [[owner,'roles-owner@example.invalid',true],[mod,'roles-mod@example.invalid',true],[other,'roles-unverified@example.invalid',false]])
    await db.query('insert into auth.users(id,email,email_confirmed_at) values($1,$2,case when $3 then clock_timestamp() else null end)',[id,email,confirmed]);
  await db.query("insert into public.platform_admins(user_id,role) values($1,'owner')",[owner]);
  const org=(await db.query("insert into public.organizations(name,slug) values('Roles test','roles-test') returning id")).rows[0].id;
  const location=(await db.query("insert into public.locations(organization_id,name) values($1,'Roles location') returning id",[org])).rows[0].id;
  const card=(await db.query('insert into public.nfc_cards(organization_id,location_id) values($1,$2) returning id',[org,location])).rows[0].id;
  const grant=(actor,email,enabled=true)=>db.query('select public.set_platform_moderator($1,$2,$3)',[actor,email,enabled]);
  await db.query('set role service_role');
  await assert.rejects(grant(owner,'roles-unverified@example.invalid'),e=>e.code==='P0002');
  await grant(owner,' ROLES-MOD@example.invalid ');
  assert.equal((await db.query('select role from public.platform_admins where user_id=$1',[mod])).rows[0].role,'moderator');
  await assert.rejects(grant(mod,'roles-unverified@example.invalid'),e=>e.code==='42501');
  await assert.rejects(grant(owner,'roles-owner@example.invalid',false),e=>e.code==='42501');
  const team=await db.query('select * from public.get_platform_team($1)',[owner]);
  assert.ok(team.rows.some(r=>r.user_id===mod));
  await assert.rejects(db.query('select * from public.get_platform_team($1)',[mod]),e=>e.code==='42501');
  pass('only owners can grant verified moderators or read the team; owner role is protected');
  await assert.rejects(db.query("select public.set_billing_card_mode($1,$2,'automatic',3,0)",[mod,org]),e=>e.code==='42501');
  await assert.rejects(db.query('update public.billing_monitor_settings set enabled=true,updated_by=$1 where id',[mod]),e=>e.code==='42501');
  await db.query('update public.billing_monitor_settings set enabled=false,updated_by=$1 where id',[owner]);
  await db.query("select public.set_platform_card_lock($1,$2,true,false,'Moderation check')",[mod,card]);
  assert.equal((await db.query('select platform_locked from public.nfc_cards where id=$1',[card])).rows[0].platform_locked,true);
  await db.query("select public.set_platform_card_lock($1,$2,false,true,'Moderation resolved')",[mod,card]);
  pass('moderators can operate audited manual card locks but cannot change payment automation or mail settings');
  await grant(owner,'roles-mod@example.invalid',false);
  await assert.rejects(db.query("select public.set_platform_card_lock($1,$2,true,false,'Stale session')",[mod,card]),e=>e.code==='42501');
  assert.equal((await db.query('select count(*)::int n from public.platform_team_audit where target_id=$1',[mod])).rows[0].n,2);
  await db.query('reset role');
  for(const fn of ['set_platform_moderator','get_platform_team']) {
    const r=(await db.query("select has_function_privilege('anon',oid,'execute') a,has_function_privilege('authenticated',oid,'execute') u,has_function_privilege('service_role',oid,'execute') s from pg_proc where proname=$1",[fn])).rows[0];
    assert.deepEqual(r,{a:false,u:false,s:true});
  }
  await db.query('set role authenticated');
  await assert.rejects(db.query("update public.platform_admins set role='owner' where user_id=$1",[mod]),e=>e.code==='42501');
  await db.query('reset role');
  pass('revocation blocks stale moderator operations; tenant role escalation and direct RPC calls are denied');
}
