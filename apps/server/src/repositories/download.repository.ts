import type { DownloadStatus } from '@projekt-manga/types';
import prisma from '../configs/prisma.config.js';

class DownloadRepository {
  async createDownload(data: {
    manga_id: string;
    chapter_id: string;
    source_id: string;
    file_path: string;
    request_id?: string | null;
  }) {
    return await prisma.download.create({
      data: {
        ...data,
        status: 'PENDING',
      },
      include: {
        manga: true,
        chapter: true,
      },
    });
  }

  async getDownloadsByChapterId(chapter_id: string) {
    return await prisma.download.findMany({ where: { chapter_id } });
  }

  /** A chapter whose pages are already on disk: a download found again, not a new one. */
  async createRestoredDownload(data: {
    manga_id: string;
    chapter_id: string;
    source_id: string;
    file_path: string;
    downloaded_path: string;
    pages: number;
  }) {
    const { pages, ...row } = data;
    return await prisma.download.create({
      data: {
        ...row,
        status: 'COMPLETED',
        pages_total: pages,
        pages_downloaded: pages,
        current_page: pages,
        completed_at: new Date(),
      },
    });
  }

  /** Points a download whose folder went missing at the copy of it that was found. */
  async relinkDownload(
    id: string,
    data: { file_path: string; downloaded_path: string; pages: number },
  ) {
    return await prisma.download.update({
      where: { id },
      data: {
        file_path: data.file_path,
        downloaded_path: data.downloaded_path,
        status: 'COMPLETED',
        pages_total: data.pages,
        pages_downloaded: data.pages,
        current_page: data.pages,
        completed_at: new Date(),
      },
    });
  }

  async getDownloadById(id: string) {
    return await prisma.download.findUnique({
      where: { id },
      include: {
        manga: true,
        chapter: true,
      },
    });
  }

  async getAllDownloads(page: { limit?: number; offset?: number } = {}) {
    return await prisma.download.findMany({
      include: {
        manga: true,
        chapter: true,
      },
      // The id settles ties (rows not started yet), so paging can't repeat or skip one.
      orderBy: [{ started_at: 'desc' }, { id: 'asc' }],
      ...(page.limit !== undefined ? { take: page.limit } : {}),
      ...(page.offset !== undefined ? { skip: page.offset } : {}),
    });
  }

  async getDownloadsByMangaId(manga_id: string) {
    return await prisma.download.findMany({
      where: { manga_id },
      include: {
        chapter: true,
      },
    });
  }

  async getDownloadsByStatus(status: DownloadStatus) {
    return await prisma.download.findMany({
      where: { status },
      include: {
        manga: true,
        chapter: true,
      },
    });
  }

  async updateDownloadStatus(id: string, status: DownloadStatus) {
    return await prisma.download.update({
      where: { id },
      data: {
        status,
        ...(status === 'IN_PROGRESS' && { started_at: new Date() }),
        ...(status === 'COMPLETED' && { completed_at: new Date() }),
      },
      include: {
        manga: true,
        chapter: true,
      },
    });
  }

  async updateDownloadProgress(
    id: string,
    data: {
      pages_total?: number;
      pages_downloaded?: number;
      current_page?: number;
      downloaded_path?: string;
    },
  ) {
    return await prisma.download.update({
      where: { id },
      data,
      include: {
        manga: true,
        chapter: true,
      },
    });
  }

  async updateDownloadPath(id: string, file_path: string) {
    return await prisma.download.update({
      where: { id },
      data: { file_path },
    });
  }

  async deleteDownload(id: string) {
    return await prisma.download.delete({
      where: { id },
    });
  }

  async getCompletedDownloads() {
    return await prisma.download.findMany({
      where: { status: 'COMPLETED' },
      include: {
        manga: true,
        chapter: true,
      },
    });
  }

  async isChapterDownloaded(chapter_id: string) {
    const download = await prisma.download.findFirst({
      where: {
        chapter_id,
        status: 'COMPLETED',
      },
    });
    return !!download;
  }

  async getDownloadByChapterId(chapter_id: string) {
    return await prisma.download.findFirst({
      where: { chapter_id },
      include: {
        manga: true,
        chapter: true,
      },
    });
  }
}

export default new DownloadRepository();
