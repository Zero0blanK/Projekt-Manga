import migrationRepository, {
  type MigrationOptions,
  type MigrationSummary,
} from '../repositories/migration.repository.js';
import { ValidationError } from '../utils/customErrors.js';

export type { MigrationOptions, MigrationSummary };

const migrateManga = async (
  from_manga_id: string,
  to_manga_id: string,
  options: MigrationOptions,
  user_id?: string,
): Promise<MigrationSummary> => {
  if (from_manga_id === to_manga_id) {
    throw new ValidationError('Cannot migrate a title onto itself');
  }

  return migrationRepository.migrate(
    from_manga_id,
    to_manga_id,
    options,
    {
      progress: 0,
      chapters_marked: 0,
      categories_moved: 0,
      history_moved: 0,
      state_copied: false,
      old_entry_removed: false,
    },
    user_id,
  );
};

const migrationService = { migrateManga };

export default migrationService;
