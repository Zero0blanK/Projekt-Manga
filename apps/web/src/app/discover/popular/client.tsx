'use client';

import { Flame, TrendingUp } from 'lucide-react';
import { DiscoverBrowsePage } from '@/components/discover/browse-page';

export function PopularPageClient() {
  return (
    <DiscoverBrowsePage
      browseKey="discover-popular"
      category="popular"
      icon={TrendingUp}
      emptyIcon={Flame}
      defaultTitle="Popular this week"
      showRankBadges
    />
  );
}
