// Explicit operator action. Identity is bound to a confirmed Auth UID, not a mutable email allowlist.
import fs from 'node:fs';
import { createClient } from '@supabase/supabase-js';
const [envFile, expectedRef, email, flag] = process.argv.slice(2);
if (!envFile || !email || !['nowcuhwgeerzqlpweyxj','jvssnpvrcwjxldfeddnw'].includes(expectedRef)) throw Error('Environment, approved project and exact owner login email required');
const env = {};
for (const line of fs.readFileSync(envFile,'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
  if (m) env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g,'');
}
if (new URL(env.NEXT_PUBLIC_SUPABASE_URL).hostname !== `${expectedRef}.supabase.co`) throw Error('Project mismatch');
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
let target = null;
for (let page=1;page<=100;page++) {
  const {data,error}=await admin.auth.admin.listUsers({page,perPage:1000});
  if(error) throw Error('Could not verify Auth users');
  for(const user of data.users) if(user.email?.toLowerCase()===email.trim().toLowerCase()) {
    if(target) throw Error('Ambiguous email identity'); target=user;
  }
  if(data.users.length<1000) break;
  if(page===100) throw Error('User search incomplete; refusing to grant');
}
if(!target?.email_confirmed_at || target.deleted_at) throw Error('An existing confirmed account is required; no grant made');
const before=await admin.from('platform_admins').select('user_id').eq('user_id',target.id).maybeSingle();
if(before.error) throw Error('Platform admin migration must be applied first');
console.log(JSON.stringify({project:expectedRef,confirmedAccount:true,userId:target.id,alreadyAdmin:!!before.data,grant:flag==='--grant'}));
if(flag==='--grant' && !before.data) {
  const result=await admin.from('platform_admins').insert({user_id:target.id,role:'owner'});
  if(result.error) throw Error('Admin grant failed');
  const verified=await admin.from('platform_admins').select('user_id').eq('user_id',target.id).single();
  if(verified.error || !verified.data) throw Error('Admin grant could not be verified');
  console.log('Owner access granted and verified.');
}
