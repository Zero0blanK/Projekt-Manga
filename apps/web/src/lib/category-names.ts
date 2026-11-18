/** The longest category name the server accepts (category_name in packages/schemas). */
export const MAX_CATEGORY_NAME = 100;

/**
 * Why a category can't have `name`, in words, or null when it can.
 *
 * Checked before anything is sent, so a name the server would refuse ("Validation failed")
 * or one that would look like something already on screen is caught where it is typed.
 * `current` is the category being renamed: keeping its own name is fine.
 */
export function categoryNameProblem(
  name: string,
  taken: { shelves: string[]; categories: string[]; current?: string },
): string | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  if (trimmed.length > MAX_CATEGORY_NAME)
    return `Category names can be up to ${MAX_CATEGORY_NAME} characters.`;
  const same = (other: string) => other.trim().toLowerCase() === trimmed.toLowerCase();
  if (taken.current && same(taken.current)) return null;
  const shelf = taken.shelves.find(same);
  if (shelf) return `“${shelf}” is already a shelf. Pick another name.`;
  const category = taken.categories.find(same);
  if (category) return `There’s already a category called “${category}”.`;
  return null;
}
