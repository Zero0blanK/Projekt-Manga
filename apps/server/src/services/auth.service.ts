import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { SESSION_COOKIE_NAME, type DevicePlatform } from '@projekt-manga/types';
import userRepository from '../repositories/user.repository.js';
import sessionRepository from '../repositories/session.repository.js';
import deviceRepository from '../repositories/device.repository.js';
import mangaRepository from '../repositories/manga.repository.js';
import chapterRepository from '../repositories/chapter.repository.js';
import libraryRepository from '../repositories/library.repository.js';
import { isShelfStatus } from '@projekt-manga/types';
import categoryRepository from '../repositories/category.repository.js';
import historyRepository from '../repositories/history.repository.js';
import userLibraryRepository from '../repositories/userLibrary.repository.js';
import userMangaStateRepository from '../repositories/userMangaState.repository.js';
import userChapterStateRepository from '../repositories/userChapterState.repository.js';
import userMangaCategoryRepository from '../repositories/userMangaCategory.repository.js';
import { DuplicateResourceError, UnauthorizedError, NotFoundError } from '../utils/customErrors.js';
import type { RegisterBody, LoginBody } from '@projekt-manga/schemas';

const BCRYPT_COST_FACTOR = 12;
/** A fixed, valid-shaped bcrypt hash of no real password, compared against when the
 * looked-up account doesn't exist — without this, an unknown email returns instantly
 * (no bcrypt call) while a known one always pays the ~cost-12 compare before rejecting,
 * and that timing difference lets an attacker enumerate which emails have accounts
 * despite the identical error message either way. */
const DUMMY_PASSWORD_HASH = bcrypt.hashSync(
  'not-a-real-password-just-for-timing',
  BCRYPT_COST_FACTOR,
);
// 90 days: the desktop's offline auto-auth (apps/desktop) relies on not having to re-login
// often. The expiry is not extended on activity.
export const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
export { SESSION_COOKIE_NAME };

/**
 * The session token is a bearer credential: whoever holds it is the account, so it gets
 * the same treatment as a password — the raw value goes to the browser and nowhere else,
 * and only its hash is stored.
 *
 * Storing the raw token as the `session` primary key would let anyone who can read the
 * database (a backup, a dump, a snapshot) impersonate every live session.
 *
 * SHA-256 with no salt or stretching is the right choice here, unlike for passwords: the
 * input is 32 bytes of CSPRNG output, so there is no dictionary to attack and nothing a
 * work factor would buy — while a slow hash would be paid on every authenticated
 * request.
 */
function generateSessionToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

function hashSessionToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function toPublicUser(user: {
  id: string;
  email: string;
  display_name: string | null;
  created_at: Date;
}) {
  return {
    id: user.id,
    email: user.email,
    display_name: user.display_name,
    created_at: user.created_at,
  };
}

/** One-time bulk copy of the shared anonymous state onto a brand-new account — only ever
 * runs for the very first account this server has had (see register's isFirstAccount
 * check), so the person who's been using the app anonymously doesn't lose their library
 * the moment they create an account. Every write here goes through each domain's own
 * claimFromAnonymous, which is skipDuplicates-safe, so a retry after a partial failure
 * can't double-claim. */
const claimExistingAnonymousData = async (user_id: string) => {
  const [libraryMangaIds, mangaStates, chaptersWithState, categoryAssignments] = await Promise.all([
    mangaRepository.listLibraryMangaIds(),
    libraryRepository.getAll(),
    chapterRepository.listChaptersWithState(),
    categoryRepository.getAllAssignments(),
  ]);

  await Promise.all([
    userLibraryRepository.claimFromAnonymous(user_id, libraryMangaIds),
    userMangaStateRepository.claimFromAnonymous(
      user_id,
      mangaStates.map((s) => ({
        manga_id: s.manga_id,
        is_bookmarked: s.is_bookmarked,
        // The column is a String under SQLite, so what comes back is `string | null`.
        // Anything not in the known set is treated as "no shelf" rather than trusted
        // through — the alternative is a cast that would let bad data spread silently.
        shelf_status: isShelfStatus(s.shelf_status) ? s.shelf_status : null,
        notification_read: s.notification_read,
      })),
    ),
    userChapterStateRepository.claimFromAnonymous(
      user_id,
      chaptersWithState.map((c) => ({
        chapter_id: c.id,
        is_read: c.is_read,
        is_bookmark: c.is_bookmark,
        last_page_read: c.last_page_read,
      })),
    ),
    userMangaCategoryRepository.claimFromAnonymous(user_id, categoryAssignments),
    historyRepository.claimAllAnonymous(user_id),
  ]);
};

const register = async (body: RegisterBody, userAgent?: string) => {
  const existing = await userRepository.getByEmail(body.email);
  if (existing) {
    throw new DuplicateResourceError('An account with this email already exists');
  }

  const password_hash = await bcrypt.hash(body.password, BCRYPT_COST_FACTOR);
  const { user, isFirstAccount } = await userRepository.createAndCheckFirstAccount({
    email: body.email,
    password_hash,
    display_name: body.display_name,
  });

  if (isFirstAccount) {
    try {
      await claimExistingAnonymousData(user.id);
    } catch (error) {
      // Without this the account would exist with none of the library it was meant to
      // take over, and registering again would only say the email is taken. Removing it
      // lets the person simply try again; the claim is idempotent.
      await userRepository.deleteById(user.id).catch(() => undefined);
      throw error;
    }
  }

  const { session, token } = await createSession(user.id, userAgent);
  return { user: toPublicUser(user), session, token };
};

const login = async (body: LoginBody, userAgent?: string) => {
  const user = await userRepository.getByEmail(body.email);
  // Always runs a compare at the same cost factor, real account or not — see
  // DUMMY_PASSWORD_HASH's comment on why an early return here would leak account
  // existence through timing despite the identical error message either way.
  const passwordMatches = await bcrypt.compare(
    body.password,
    user?.password_hash ?? DUMMY_PASSWORD_HASH,
  );
  if (!user || !passwordMatches) {
    throw new UnauthorizedError('Incorrect email or password');
  }

  const { session, token } = await createSession(user.id, userAgent);
  return { user: toPublicUser(user), session, token };
};

/** Returns the stored row *and* the raw token, which exists only in this return value
 * and the Set-Cookie header it ends up in — it is never persisted. */
const createSession = async (user_id: string, userAgent?: string, device_id?: string) => {
  // Opportunistic sweep rather than a scheduler: logins are infrequent and this is a single
  // indexed delete, so it keeps the table bounded without another moving part. Never allowed
  // to fail a login — the session below is what the caller actually asked for.
  await sessionRepository.deleteExpired().catch(() => 0);

  const token = generateSessionToken();
  const expires_at = new Date(Date.now() + SESSION_TTL_MS);
  const session = await sessionRepository.create({
    id: hashSessionToken(token),
    user_id,
    device_id: device_id ?? null,
    user_agent: userAgent ?? null,
    expires_at,
  });
  return { session, token };
};

/** Returns null for a missing/expired/invalid session rather than throwing — this is the
 * "who is this request from, if anyone" check every route can safely call. Takes the raw
 * cookie value; the stored key is its hash. */
const getSessionUser = async (sessionToken: string | undefined) => {
  if (!sessionToken) {
    return null;
  }

  const session = await sessionRepository.getByIdWithUser(hashSessionToken(sessionToken));
  if (!session) {
    return null;
  }

  if (session.expires_at.getTime() <= Date.now()) {
    // Self-healing: the row can never authenticate anything again, so drop it as it is
    // encountered rather than leaving it for the next login's sweep.
    await sessionRepository.deleteById(session.id);
    return null;
  }

  return { user: session.user, session };
};

/** Takes the raw cookie value rather than req.sessionId so a session that has already
 * expired — and therefore never reached req.sessionId — is still revoked on logout
 * instead of being left in the table. */
const logout = async (sessionToken: string | undefined) => {
  if (sessionToken) {
    await sessionRepository.deleteById(hashSessionToken(sessionToken));
  }
};

/** `currentSessionId` is the stored (hashed) id from req.sessionId, not a raw token —
 * it's compared against the primary key, so it must already be in stored form. */
const signOutOtherDevices = async (user_id: string, currentSessionId: string) => {
  return await sessionRepository.deleteAllExcept(user_id, currentSessionId);
};

const registerDevice = async (user_id: string, label: string, platform: DevicePlatform) => {
  return await deviceRepository.create({ user_id, label, platform });
};

const deleteAccount = async (user_id: string, password: string) => {
  const user = await userRepository.getById(user_id);
  if (!user) {
    throw new NotFoundError('Account not found');
  }
  if (!(await bcrypt.compare(password, user.password_hash))) {
    throw new UnauthorizedError('Incorrect password');
  }
  await userRepository.deleteById(user_id);
};

const authService = {
  register,
  login,
  logout,
  signOutOtherDevices,
  getSessionUser,
  registerDevice,
  deleteAccount,
  toPublicUser,
};

export default authService;
