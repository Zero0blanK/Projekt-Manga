import './dotenv.config.js';
import { assertValidEnv } from './env.js';

/**
 * Loads .env and validates the environment, as a module rather than a call in server.ts.
 *
 * That distinction matters: ES module imports are hoisted and evaluated before any
 * statement in the importing file, so a bare `assertValidEnv()` sitting between the
 * imports in server.ts would in fact run *after* app.js — and therefore after
 * prisma.config.js had already tried to build a connection from the config being
 * validated. Importing this first is what actually orders the check ahead of everything
 * it's meant to protect.
 */
assertValidEnv();
