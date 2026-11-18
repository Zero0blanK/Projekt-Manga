import { NotFoundPage } from '@/components/not-found-page';

/** The source answered, but no longer has this title (or the link was for one it never had). */
export default function SourceTitleNotFound() {
  return (
    <NotFoundPage
      title="The source doesn't have this title"
      links={[
        { href: '/discover', label: 'Back to Discover' },
        { href: '/', label: 'Library' },
      ]}
    >
      It may have been removed or moved to a new address on the source. Search for it in Discover;
      another source may have it too.
    </NotFoundPage>
  );
}
