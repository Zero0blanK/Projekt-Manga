import prisma from '../configs/prisma.config.js';

const getForSource = async (source_key: string) => {
  return await prisma.source_browser_session.findMany({ where: { source_key } });
};

/** Replaces everything stored for the source in one transaction, so a capture never
 * leaves the cookies of an earlier one beside it. */
const replaceForSource = async (
  source_key: string,
  rows: Array<{ host: string; cookies_encrypted: string; user_agent: string }>,
) => {
  await prisma.$transaction([
    prisma.source_browser_session.deleteMany({ where: { source_key } }),
    ...rows.map((row) => prisma.source_browser_session.create({ data: { source_key, ...row } })),
  ]);
};

const deleteForSource = async (source_key: string) => {
  return await prisma.source_browser_session.deleteMany({ where: { source_key } });
};

const sourceBrowserSessionRepository = {
  getForSource,
  replaceForSource,
  deleteForSource,
};

export default sourceBrowserSessionRepository;
