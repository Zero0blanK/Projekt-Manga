import { NotFoundPage } from '@/components/not-found-page';

export default function NotFound() {
  return (
    <NotFoundPage
      title="Page not found"
      links={[
        { href: '/', label: 'Back to library' },
        { href: '/discover', label: 'Discover' },
      ]}
    >
      There&apos;s nothing at this address. The link may be mistyped, or from an older version of
      the app.
    </NotFoundPage>
  );
}
