'use client';

import { Flame } from 'lucide-react';
import { DiscoverBrowsePage } from '@/components/discover/browse-page';

export function PopularPageClient() {
  return (
    <DiscoverBrowsePage
      browseKey="discover-popular"
      category="popular"
      emptyIcon={Flame}
      defaultTitle="Popular this week"
      showRankBadges
    />
  );
}
