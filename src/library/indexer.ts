import { Directory, File, Paths } from 'expo-file-system';
import { strFromU8 } from 'fflate';

import {
  ArchiveRow,
  PageInput,
  ZipEntryInput,
  getPages,
  getZipEntries,
  markArchiveIndexed,
  replaceArchiveIndex,
  setArchiveCover,
} from '@/db/repo';
import { FileHandleSource } from '@/platform/fileSource';
import { inflateEntry } from '@/zip/inflate';
import {
  PANELS_ENTRY_NAME,
  entryExtension,
  isImageEntry,
  isPanelsEntry,
  readCentralDirectory,
  resolveDataOffset,
} from '@/zip/zipIndex';
import { ZipArchive } from '@/zip/zipReader';

import { isPageImage } from './layout';
import { PanelsDoc, parsePanelsJson } from './panels';
import { pageCompare, parseEntryName } from './parse';

export interface IndexResult {
  pageCount: number;
  hasPanels: boolean;
  error: string | null;
}

async function indexCbz(archive: ArchiveRow): Promise<IndexResult> {
  const src = new FileHandleSource(archive.uri);
  try {
    const dir = await readCentralDirectory(src);
    const images = dir.entries.filter(isImageEntry).sort((a, b) => pageCompare(a.name, b.name));
    const panelsEntry = dir.entries.find(isPanelsEntry);
    let panels: PanelsDoc | null = null;
    if (panelsEntry) {
      const off = await resolveDataOffset(src, panelsEntry);
      const bytes = await inflateEntry(src, panelsEntry, off);
      panels = parsePanelsJson(strFromU8(bytes));
    }
    const entries: ZipEntryInput[] = dir.entries.map((e) => ({
      entry_index: e.index,
      name: e.name,
      method: e.method,
      flags: e.flags,
      crc32: e.crc32,
      comp_size: e.compressedSize,
      uncomp_size: e.uncompressedSize,
      local_header_offset: e.localHeaderOffset,
      data_offset: null,
    }));
    const pages: PageInput[] = images.map((e, i) => {
      const info = parseEntryName(e.name);
      const pp = panels?.pages[e.name];
      return {
        page_index: i,
        entry_index: e.index,
        uri: null,
        entry_name: e.name,
        chapter: info.chapter ?? null,
        page_no: info.page ?? null,
        extra: info.extra ?? null,
        width: pp?.w ?? null,
        height: pp?.h ?? null,
        panels_json: pp ? JSON.stringify(pp.panels) : null,
      };
    });
    await replaceArchiveIndex(archive.id, entries, pages);
    return { pageCount: pages.length, hasPanels: panels !== null, error: null };
  } finally {
    src.close();
  }
}

async function indexDir(archive: ArchiveRow): Promise<IndexResult> {
  const dir = new Directory(archive.uri);
  const items = dir.list();
  const files = items.filter((x): x is File => x instanceof File);
  const images = files.filter((f) => isPageImage(f.name)).sort((a, b) => pageCompare(a.name, b.name));
  const panelsFile = files.find((f) => f.name === PANELS_ENTRY_NAME);
  let panels: PanelsDoc | null = null;
  if (panelsFile) {
    const text = await panelsFile.text();
    panels = parsePanelsJson(text);
  }
  const pages: PageInput[] = images.map((f, i) => {
    const info = parseEntryName(f.name);
    const pp = panels?.pages[f.name];
    return {
      page_index: i,
      entry_index: null,
      uri: f.uri,
      entry_name: f.name,
      chapter: info.chapter ?? null,
      page_no: info.page ?? null,
      extra: info.extra ?? null,
      width: pp?.w ?? null,
      height: pp?.h ?? null,
      panels_json: pp ? JSON.stringify(pp.panels) : null,
    };
  });
  await replaceArchiveIndex(archive.id, [], pages);
  return { pageCount: pages.length, hasPanels: panels !== null, error: null };
}

/** Build the page index for one archive. Never throws; failures are recorded on the row. */
export async function indexArchive(archive: ArchiveRow): Promise<IndexResult> {
  let result: IndexResult;
  try {
    result = archive.kind === 'cbz' ? await indexCbz(archive) : await indexDir(archive);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[mangarino] index failed', archive.file_name, message);
    result = { pageCount: 0, hasPanels: false, error: message };
  }
  await markArchiveIndexed(archive.id, result.pageCount, result.hasPanels, result.error);
  return result;
}

function coversDir(): Directory {
  const d = new Directory(Paths.document, 'covers');
  if (!d.exists) d.create({ intermediates: true, idempotent: true });
  return d;
}

/** Extract page 0 into the covers folder and record it on the archive. Returns the cover URI. */
export async function makeArchiveCover(archive: ArchiveRow): Promise<string | null> {
  if (archive.page_count === 0) return null;
  const pages = await getPages(archive.id);
  const first = pages[0];
  if (!first) return null;
  try {
    let uri: string;
    if (archive.kind === 'dir') {
      if (!first.uri) return null;
      uri = first.uri;
    } else {
      if (first.entry_index === null) return null;
      const rows = await getZipEntries(archive.id);
      const src = new FileHandleSource(archive.uri);
      try {
        const zip = await ZipArchive.open(src);
        for (const r of rows) if (r.data_offset !== null) zip.primeDataOffset(r.entry_index, r.data_offset);
        const entry = zip.entries[first.entry_index];
        if (!entry) return null;
        const bytes = await zip.extract(entry);
        const file = new File(coversDir(), `${archive.id}.${entryExtension(entry.name)}`);
        if (file.exists) file.delete();
        file.write(bytes);
        uri = file.uri;
      } finally {
        src.close();
      }
    }
    await setArchiveCover(archive.id, uri);
    return uri;
  } catch (err) {
    console.warn('[mangarino] cover failed', archive.file_name, err instanceof Error ? err.message : String(err));
    return null;
  }
}
