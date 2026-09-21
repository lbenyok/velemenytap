// Narrow additive rollout: refuses wrong projects, schema drift and other pending migrations.
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const [envFile, expectedRef, applyFlag] = process.argv.slice(2);
if (!envFile || !['nowcuhwgeerzqlpweyxj', 'jvssnpvrcwjxldfeddnw'].includes(expectedRef)) throw Error('Specify environment file and approved project ref');
const env = {};
for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
  const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
  if (match) env[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '');
}
const url = new URL(env.SUPABASE_DB_URL);
const actualRef = /^db\.([a-z0-9]+)\.supabase\.co$/.exec(url.hostname)?.[1]
  ?? (/^aws-\d+-[a-z0-9-]+\.pooler\.supabase\.com$/.test(url.hostname) ? /^postgres\.([a-z0-9]+)$/.exec(decodeURIComponent(url.username))?.[1] : null);
if (actualRef !== expectedRef || new URL(env.NEXT_PUBLIC_SUPABASE_URL).hostname !== `${expectedRef}.supabase.co`) throw Error('Project identity mismatch');
const migrationName = '20260921170000_platform_owner_and_moderators.sql';
const directory = path.resolve('supabase/migrations');
const files = fs.readdirSync(directory).filter(f => f.endsWith('.sql')).sort();
const expected = files.filter(f => f !== migrationName).map(f => f.split('_')[0]);
const db = new pg.Client({ connectionString: env.SUPABASE_DB_URL, connectionTimeoutMillis: 15000 });
try {
  await db.connect();
  await db.query('begin');
  await db.query("set local lock_timeout = '10s'");
  await db.query("select pg_advisory_xact_lock(hashtext('velemenytap-admin-roles-migration'))");
  const history = (await db.query('select version from supabase_migrations.schema_migrations order by version')).rows.map(x => x.version);
  const alreadyApplied = history.includes('20260921170000');
  if (JSON.stringify(history.filter(v => v !== '20260921170000')) !== JSON.stringify(expected)) throw Error('Migration history differs from expected baseline; refusing to apply');
  console.log(JSON.stringify({ project: expectedRef, baselineMigrations: expected.length, alreadyApplied, apply: applyFlag === '--apply' }));
  if (!alreadyApplied && applyFlag === '--apply') {
    const sql = fs.readFileSync(path.join(directory, migrationName), 'utf8');
    await db.query(sql);
    await db.query('insert into supabase_migrations.schema_migrations(version,name,statements) values ($1,$2,$3)', ['20260921170000','platform_owner_and_moderators',[sql]]);
  }
  await db.query('commit');
  console.log(applyFlag === '--apply' ? 'Migration ready.' : 'Read-only preflight passed.');
} catch (error) {
  await db.query('rollback').catch(() => {});
  console.error('Migration failed:', error.code || 'preflight', String(error.message).replaceAll(env.SUPABASE_DB_URL, '[redacted]'));
  process.exitCode = 1;
} finally { await db.end(); }

