'use client';

import { Clock } from 'lucide-react';
import { DiscoverBrowsePage } from '@/components/discover/browse-page';

export function LatestPageClient() {
  return (
    <DiscoverBrowsePage
      browseKey="discover-latest"
      category="latest"
      icon={Clock}
      emptyIcon={Clock}
      defaultTitle="Latest"
    />
  );
}
