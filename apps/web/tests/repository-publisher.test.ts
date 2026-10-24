import { describe, expect, it } from 'vitest';
import { PROJEKTMANGA_SOURCES_URL, repositoryPublisher } from '@/lib/repository-url';

describe('repositoryPublisher', () => {
  it('names the account that owns a GitHub-hosted repository', () => {
    expect(
      repositoryPublisher({ url: PROJEKTMANGA_SOURCES_URL, name: 'ProjektManga sources' }),
    ).toBe('Zero0blanK');
    expect(
      repositoryPublisher({ url: 'https://github.com/someone/repo/raw/main/index.json' }),
    ).toBe('someone');
    expect(repositoryPublisher({ url: 'https://someone.github.io/repo/index.json' })).toBe(
      'someone',
    );
  });

  it('falls back to the website, then the repository name, then the URL', () => {
    expect(
      repositoryPublisher({
        url: 'https://cdn.example.com/index.json',
        website: 'https://gitlab.com/maintainer/sources',
        name: 'Sources',
      }),
    ).toBe('maintainer');
    expect(
      repositoryPublisher({ url: 'https://cdn.example.com/index.json', name: 'Sources' }),
    ).toBe('Sources');
    expect(repositoryPublisher({ url: 'https://cdn.example.com/index.json', name: null })).toBe(
      'https://cdn.example.com/index.json',
    );
  });
});
