-- Cookies a real browser earned for a source (a passed Cloudflare challenge, a login),
-- one row per source and cookie domain (see schema.prisma). Host-level, not per account:
-- the sandbox sends them with every request that source makes.
CREATE TABLE "source_browser_sessions" (
    "source_key" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "cookies_encrypted" TEXT NOT NULL,
    "user_agent" TEXT NOT NULL,
    "updated_at" DATETIME NOT NULL,

    PRIMARY KEY ("source_key", "host")
);
