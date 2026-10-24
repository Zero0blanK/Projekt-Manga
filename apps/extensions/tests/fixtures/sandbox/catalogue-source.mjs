const rows = ['a', 'a', 'b', 'c'].map((id) => ({
  id,
  slug: id,
  title: id,
  source: 'catalogue-fixture',
  thumbnail_url: '',
}));
export default {
  id: 'catalogue-fixture',
  async fetchManga(_category, { offset, limit }) {
    return rows.slice(offset, offset + limit);
  },
  async searchManga(_query, pagination) {
    return this.fetchManga(undefined, pagination);
  },
};
