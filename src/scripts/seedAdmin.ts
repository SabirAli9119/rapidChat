import { connectDatabase, disconnectDatabase } from '../config/database';
import { env } from '../config/env';
import { User } from '../models/User.model';
import { recordSecurityEvent } from '../services/audit.service';
import { hashPassword } from '../services/auth.service';
import { isDuplicateKeyError } from '../utils/db';
import { emailSchema } from '../validators/auth.validator';
import { passwordSchema } from '../validators/common.validator';

const say = (message: string): void => console.log(message);
const fail = (message: string): number => {
  console.error(`\n❌ ${message}\n`);
  return 1;
};

/** Returns the exit code: 0 = done, 1 = nothing changed because something needs your attention. */
async function seed(): Promise<number> {
  const promote = process.argv.includes('--promote');
  const { SEED_ADMIN_EMAIL, SEED_ADMIN_PASSWORD, SEED_ADMIN_USERNAME: username } = env;

  if (!SEED_ADMIN_EMAIL || !SEED_ADMIN_PASSWORD) {
    return fail(
      'Set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD in your .env file first (the password needs 12 or more characters), then run this again.',
    );
  }

  const emailResult = emailSchema.safeParse(SEED_ADMIN_EMAIL);
  if (!emailResult.success) return fail(`SEED_ADMIN_EMAIL is not a valid email address.`);
  const email = emailResult.data;

  const passwordResult = passwordSchema.safeParse(SEED_ADMIN_PASSWORD);
  if (!passwordResult.success) {
    return fail(`SEED_ADMIN_PASSWORD is too weak: ${passwordResult.error.issues.map((i) => i.message).join('; ')}`);
  }
  if (SEED_ADMIN_PASSWORD.toLowerCase().includes(username)) {
    return fail('SEED_ADMIN_PASSWORD must not contain the admin username.');
  }

  await connectDatabase();

  // ----- the account already exists -----
  const existing = await User.findOne({ email }).select('username role status emailVerified');
  if (existing) {
    const ready = existing.role === 'admin' && existing.status === 'active' && existing.emailVerified;
    if (ready) {
      say(`\n✅ An administrator with this email already exists (username: ${existing.username}). Nothing was changed.\n`);
      return 0;
    }
    if (!promote) {
      return fail(
        `An account with this email exists but is not an active, verified administrator (role: ${existing.role}, status: ${existing.status}, email verified: ${existing.emailVerified}).\n` +
          `   To make it one, run:  npx tsx src/scripts/seedAdmin.ts --promote\n` +
          `   (Its password stays as it is.)`,
      );
    }

    const previousRole = existing.role;
    existing.role = 'admin';
    existing.status = 'active';
    existing.statusReason = null;
    existing.emailVerified = true;
    existing.emailVerifiedAt = existing.emailVerifiedAt ?? new Date();
    await existing.save();
    await recordSecurityEvent({
      action: 'user.role_change',
      targetUserId: existing.id,
      metadata: { source: 'seed-script', previousRole, newRole: 'admin' },
    });
    say(`\n✅ ${existing.username} is now an active, verified administrator. The password was not changed.\n`);
    return 0;
  }

  // ----- create a new account -----
  if (await User.exists({ username })) {
    return fail(`The username "${username}" is already taken by another account. Set SEED_ADMIN_USERNAME in .env to a different name.`);
  }

  let created;
  try {
    created = await User.create({
      username,
      email,
      passwordHash: await hashPassword(SEED_ADMIN_PASSWORD),
      displayName: 'Administrator',
      role: 'admin',
      emailVerified: true,
      emailVerifiedAt: new Date(),
    });
  } catch (err) {
    if (isDuplicateKeyError(err)) return fail('That username or email was just taken. Try again.');
    throw err;
  }

  await recordSecurityEvent({
    action: 'user.role_change',
    targetUserId: created.id,
    metadata: { source: 'seed-script', previousRole: null, newRole: 'admin' },
  });

  say(`\n✅ Administrator created.`);
  say(`   username: ${username}`);
  say(`   email:    ${email}`);
  say(`   id:       ${created.id}`);
  say(`\nLog in with POST /api/v1/auth/login (identifier = the username or the email).`);
  say(`Then REMOVE SEED_ADMIN_PASSWORD from your .env file: it is only needed to create the account.\n`);
  return 0;
}

async function main(): Promise<number> {
  try {
    return await seed();
  } catch (err) {
    console.error('\n❌ The seed script failed:', err instanceof Error ? err.message : err, '\n');
    return 1;
  } finally {
    await disconnectDatabase().catch(() => undefined);
  }
}

main().then((code) => process.exit(code));