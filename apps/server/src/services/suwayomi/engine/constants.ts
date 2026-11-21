/**
 * Names Suwayomi-Server itself uses, kept in this one file.
 *
 * Its configuration properties still carry the project's old name in their prefix. They
 * are Suwayomi's identifiers, not ours: nothing here is shown in the app, and nothing
 * outside this file spells them.
 */

/** Prefix of Suwayomi's JVM configuration properties (`-D<prefix>.server.<key>`). */
const CONFIG_PREFIX = 'suwayomi.tachidesk.config';

/** The JVM property that sets the engine's data folder (extensions, their settings,
 * `server.conf`). Without it, Suwayomi uses a folder in the user's own app data. */
export const ROOT_DIR_PROPERTY = `${CONFIG_PREFIX}.server.rootDir`;

/** The engine's configuration file, inside its data folder. */
export const SERVER_CONF_FILE = 'server.conf';

/** The GraphQL endpoint, relative to the engine's address. */
export const GRAPHQL_PATH = '/api/graphql';

/** The value of `server.authMode` that turns on HTTP basic authentication. */
export const BASIC_AUTH_MODE = 'BASIC_AUTH';
