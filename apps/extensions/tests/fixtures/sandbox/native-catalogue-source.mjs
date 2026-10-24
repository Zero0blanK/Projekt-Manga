export default {
  id: 'native-catalogue-fixture',
  async fetchManga() {
    return [];
  },
  async fetchMangaPage(category = 'latest', pagination = {}, filters = {}) {
    return {
      items: [
        {
          id: 'native',
          slug: 'native',
          title: `${category}:${pagination.limit ?? 20}:${filters.status ?? 'all'}`,
          source: this.id,
          thumbnail_url: '',
        },
      ],
      hasMore: false,
    };
  },
  async searchMangaPage(query = '', pagination = {}, filters = {}) {
    return this.fetchMangaPage(query || 'search', pagination, filters);
  },
};
