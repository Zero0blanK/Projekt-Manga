import prisma from '../configs/prisma.config.js';

/** One row per identity: the anonymous library, or an account. */
const settingId = (user_id: string | null) => (user_id ? `user:${user_id}` : 'local');

const find = async (user_id: string | null) =>
  prisma.translation_setting.findUnique({ where: { id: settingId(user_id) } });

const save = async (
  user_id: string | null,
  data: { provider: string; url: string | null; key_encrypted: string | null },
) =>
  prisma.translation_setting.upsert({
    where: { id: settingId(user_id) },
    create: { id: settingId(user_id), user_id, ...data },
    update: data,
  });

const remove = async (user_id: string | null) => {
  await prisma.translation_setting.deleteMany({ where: { id: settingId(user_id) } });
};

const translationSettingRepository = { find, save, remove };

export default translationSettingRepository;
