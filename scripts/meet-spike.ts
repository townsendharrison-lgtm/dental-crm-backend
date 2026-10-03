/**
 * Phase 0 spike: verify external Gmail co-hosts + auto transcription/Gemini notes.
 *
 * 1) Create a test space and invite people:
 *      npm run meet:spike -- create --cohost mentor.test@gmail.com --guest student.test@gmail.com
 *    Both Gmail users join the printed link (DSG account stays OUT), talk ~5 minutes, leave.
 *
 * 2) ~15-60 minutes later, check what Google produced:
 *      npm run meet:spike -- check spaces/XXXXXXXX
 */
import 'dotenv/config';
import { authMode, dsgUserEmail, initGoogleAuth } from '../src/services/google/googleAuth.js';
import {
  addMember,
  createSpace,
  getSpace,
  listConferenceRecords,
  listMembers,
  listSmartNotes,
  listTranscripts,
  docUrl,
} from '../src/services/google/meetClient.js';

function argValues(flag: string): string[] {
  const out: string[] = [];
  const argv = process.argv.slice(2);
  argv.forEach((a, i) => {
    if (a === flag && argv[i + 1]) out.push(argv[i + 1]);
  });
  return out;
}

async function create() {
  const cohosts = argValues('--cohost');
  const guests = argValues('--guest');
  const space = await createSpace();
  console.log('\n✅ Space created');
  console.log('  name       :', space.name);
  console.log('  link       :', space.meetingUri);
  console.log('  config     :', JSON.stringify(space.config, null, 2));

  for (const email of cohosts) {
    try {
      await addMember(space.name, email, true);
      console.log(`  ✅ co-host added: ${email}`);
    } catch (e: any) {
      console.log(`  ❌ co-host FAILED: ${email} -> ${e.message}`);
    }
  }
  for (const email of guests) {
    try {
      await addMember(space.name, email, false);
      console.log(`  ✅ guest added  : ${email}`);
    } catch (e: any) {
      console.log(`  ❌ guest FAILED : ${email} -> ${e.message}`);
    }
  }
  console.log('\nMembers now:', await listMembers(space.name));
  console.log(`\nNext: have ONLY the Gmail users join ${space.meetingUri}, talk 5 min, leave.`);
  console.log(`Then run: npm run meet:spike -- check ${space.name}\n`);
}

async function check(spaceName: string) {
  const space = await getSpace(spaceName);
  console.log('\nSpace config:', JSON.stringify(space.config, null, 2));
  console.log('Members:', await listMembers(spaceName));
  const records = await listConferenceRecords(spaceName);
  if (!records.length) {
    console.log('\n⚠️  No conference records yet (nobody joined, or Google has not indexed it).');
    return;
  }
  for (const r of records) {
    console.log(`\nConference ${r.name}  start=${r.startTime}  end=${r.endTime || '(live)'}`);
    const transcripts = await listTranscripts(r.name);
    const notes = await listSmartNotes(r.name);
    console.log(transcripts.length ? '  Transcripts:' : '  ❌ No transcript');
    for (const t of transcripts) console.log(`    - ${t.state} ${docUrl(t.docsDestination) || ''}`);
    console.log(notes.length ? '  Gemini notes:' : '  ❌ No Gemini notes');
    for (const n of notes) console.log(`    - ${n.state} ${docUrl(n.docsDestination) || ''}`);
  }
}

async function main() {
  await initGoogleAuth();
  if (!authMode()) {
    console.error(
      'Google account not connected. Set GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET and click ' +
        '"Connect Google account" in Admin → Rules engine → Platform.',
    );
    process.exit(1);
  }
  console.log(`Acting as ${dsgUserEmail()} via ${authMode()}`);
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'create') return create();
  if (cmd === 'check' && arg) return check(arg);
  console.log('Usage:\n  meet:spike -- create --cohost a@gmail.com --guest b@gmail.com\n  meet:spike -- check spaces/XXXX');
}

main().catch((e) => {
  console.error('❌', e?.message || e);
  if (e?.details) console.error(JSON.stringify(e.details, null, 2));
  process.exit(1);
});
