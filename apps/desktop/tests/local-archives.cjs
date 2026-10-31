const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(entries) {
  const local = [],
    central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name),
      bytes = entry.bytes;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(entry.flags ?? 0, 6);
    header.writeUInt32LE(crc32(bytes), 14);
    header.writeUInt32LE(bytes.length, 18);
    header.writeUInt32LE(entry.size ?? bytes.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, bytes);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(0x0314, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(entry.flags ?? 0, 8);
    record.writeUInt32LE(crc32(bytes), 16);
    record.writeUInt32LE(bytes.length, 20);
    record.writeUInt32LE(entry.size ?? bytes.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(entry.attributes ?? 0, 38);
    record.writeUInt32LE(offset, 42);
    central.push(record, name);
    offset += header.length + name.length + bytes.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

test('local archive boundary, import validation, natural page order and bounded reads', async () => {
  // OS temp, not a directory inside the repo: this test used to mkdtemp under the
  // repository root's build/ and never remove it, so every run left another
  // archive-validation-* tree behind in the working copy.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-validation-'));
  const handlers = new Map();
  let selected,
    denied = false,
    gate;
  const originalLoad = Module._load;
  const electron = {
    app: { getPath: () => root },
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [selected] }) },
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
  };
  Module._load = function (request, parent, main) {
    if (request === 'electron') return electron;
    if (request === './auth-cache' && parent.filename.endsWith('local-archives.js'))
      return { getCachedSession: () => null };
    return originalLoad.call(this, request, parent, main);
  };
  try {
    const { registerLocalArchiveHandlers } = require('../dist/main/local-archives.js');
    registerLocalArchiveHandlers(async () => {
      if (denied) throw new Error('Account mismatch');
      if (gate) await gate;
      return async () => {
        if (denied) throw new Error('Account changed');
      };
    });
    const call = (name, ...args) => handlers.get(`desktop:archives:${name}`)({}, ...args);
    const ownerRoot = path.join(
      root,
      'local-archives',
      require('node:crypto').createHash('sha256').update('anonymous').digest('hex'),
    );
    const interrupted = path.join(ownerRoot, '.partial-12345678-1234-4234-8234-123456789abc');
    const unrelated = path.join(ownerRoot, '.partial-unrelated');
    await fs.mkdir(interrupted, { recursive: true });
    await fs.mkdir(unrelated);
    await fs.writeFile(path.join(interrupted, '0.png'), Buffer.from('interrupted data'));
    assert.deepEqual(await call('list'), []);
    await assert.rejects(fs.stat(interrupted), { code: 'ENOENT' });
    assert.equal((await fs.stat(unrelated)).isDirectory(), true);
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
      'base64',
    );
    const hugePng = Buffer.from(png);
    hugePng.writeUInt32BE(100000, 16);
    hugePng.writeUInt32BE(100000, 20);
    selected = path.join(root, 'valid.cbz');
    await fs.writeFile(
      selected,
      zip([
        { name: '10.png', bytes: png },
        { name: '2.png', bytes: png },
      ]),
    );
    const imported = await call('import');
    assert.equal(imported.pageCount, 2);
    assert.equal((await call('list'))[0].id, imported.id);
    assert.deepEqual(Buffer.from((await call('page', imported.id, 0)).bytes), png);
    const owner = (await fs.readdir(path.join(root, 'local-archives')))[0];
    const manifest = JSON.parse(
      await fs.readFile(
        path.join(root, 'local-archives', owner, imported.id, 'manifest.json'),
        'utf8',
      ),
    );
    assert.deepEqual(manifest.pages, ['1.png', '0.png']);
    denied = true;
    await assert.rejects(call('list'), /Account mismatch/);
    await assert.rejects(call('remove', imported.id), /Account mismatch/);
    denied = false;
    let release;
    gate = new Promise((resolve) => {
      release = resolve;
    });
    const first = call('page', imported.id, 0),
      second = call('page', imported.id, 1);
    await assert.rejects(call('page', imported.id, 0), /busy/);
    release();
    gate = undefined;
    await Promise.all([first, second]);
    await assert.rejects(call('page', '../outside', 0), /could not be loaded/);
    await assert.rejects(call('page', imported.id, -1), /could not be loaded/);
    for (const invalid of [
      { name: '../escape.png', bytes: png },
      { name: 'encrypted.png', bytes: png, flags: 1 },
      { name: 'link.png', bytes: png, attributes: 0xa0000000 },
      { name: 'unsupported.svg', bytes: png },
      { name: 'fake.png', bytes: Buffer.from('not an image') },
      { name: 'oversized.png', bytes: png, size: 33 * 1024 * 1024 },
      { name: 'huge-dimensions.png', bytes: hugePng },
    ]) {
      selected = path.join(root, 'invalid.cbz');
      await fs.writeFile(selected, zip([invalid]));
      await assert.rejects(call('import'));
      assert.equal((await call('list')).length, 1);
      assert.equal(
        (await fs.readdir(path.join(root, 'local-archives', owner))).some((name) =>
          /^\.partial-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
            name,
          ),
        ),
        false,
      );
    }
    await call('remove', imported.id);
    assert.deepEqual(await call('list'), []);
    assert.ok(
      (await fs.stat(path.join(root, 'valid.cbz'))).isFile(),
      'Removal must retain the original CBZ',
    );
  } finally {
    Module._load = originalLoad;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('ZIP, EPUB and folder imports, library folders read in place, and comics opened from outside', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-formats-'));
  const handlers = new Map();
  let selected;
  const originalLoad = Module._load;
  const electron = {
    app: { getPath: () => root },
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [selected] }) },
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
  };
  Module._load = function (request, parent, main) {
    if (request === 'electron') return electron;
    if (request === './auth-cache' && parent.filename.endsWith('local-archives.js'))
      return { getCachedSession: () => null };
    return originalLoad.call(this, request, parent, main);
  };
  const modulePath = require.resolve('../dist/main/local-archives.js');
  delete require.cache[modulePath];
  try {
    const archives = require(modulePath);
    archives.registerLocalArchiveHandlers(async () => async () => {});
    const call = (name, ...args) => handlers.get(`desktop:archives:${name}`)({}, ...args);
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
      'base64',
    );
    const comicInfo = Buffer.from(
      '<ComicInfo><Series>Frieren</Series><Number>3</Number><Writer>Yamada</Writer></ComicInfo>',
    );

    // A ZIP with ComicInfo.xml is titled from it.
    selected = path.join(root, 'volume.zip');
    await fs.writeFile(
      selected,
      zip([
        { name: 'ComicInfo.xml', bytes: comicInfo },
        { name: 'p1.png', bytes: png },
      ]),
    );
    const fromZip = await call('import', 'file');
    assert.equal(fromZip.title, 'Frieren #3');
    assert.equal(fromZip.series, 'Frieren');
    assert.equal(fromZip.writer, 'Yamada');

    // An EPUB keeps its spine order and skips its non-page parts.
    selected = path.join(root, 'book.epub');
    await fs.writeFile(
      selected,
      zip([
        { name: 'mimetype', bytes: Buffer.from('application/epub+zip') },
        {
          name: 'OEBPS/content.opf',
          bytes: Buffer.from(
            '<package><manifest><item id="a" href="a.xhtml"/><item id="b" href="b.xhtml"/></manifest><spine><itemref idref="b"/><itemref idref="a"/></spine></package>',
          ),
        },
        { name: 'OEBPS/a.xhtml', bytes: Buffer.from('<img src="img/1.png"/>') },
        { name: 'OEBPS/b.xhtml', bytes: Buffer.from('<img src="img/2.png"/>') },
        { name: 'OEBPS/style.css', bytes: Buffer.from('body{}') },
        { name: 'OEBPS/img/1.png', bytes: png },
        { name: 'OEBPS/img/2.png', bytes: png },
      ]),
    );
    const fromEpub = await call('import', 'file');
    assert.equal(fromEpub.pageCount, 2);
    const owner = (await fs.readdir(path.join(root, 'local-archives')))[0];
    const epubManifest = JSON.parse(
      await fs.readFile(
        path.join(root, 'local-archives', owner, fromEpub.id, 'manifest.json'),
        'utf8',
      ),
    );
    // Entry 2.png was unpacked second (as 1.png) and comes first in the spine.
    assert.deepEqual(epubManifest.pages, ['1.png', '0.png']);

    // A folder of pages; other files in it are ignored.
    const folder = path.join(root, 'loose pages');
    await fs.mkdir(folder);
    await fs.writeFile(path.join(folder, '10.png'), png);
    await fs.writeFile(path.join(folder, '2.png'), png);
    await fs.writeFile(path.join(folder, 'notes.txt'), 'not a page');
    selected = folder;
    const fromFolder = await call('import', 'folder');
    assert.equal(fromFolder.pageCount, 2);
    assert.equal(fromFolder.title, 'loose pages');
    await assert.rejects(call('import', 'somewhere'), /Invalid import kind/);

    // A library folder is read in place: a series sub-folder, and a loose archive.
    const library = path.join(root, 'library');
    const series = path.join(library, 'Series A');
    await fs.mkdir(path.join(series, 'Chapter 2'), { recursive: true });
    const chapterOne = path.join(series, 'Chapter 1.cbz');
    await fs.writeFile(chapterOne, zip([{ name: '1.png', bytes: png }]));
    await fs.writeFile(path.join(series, 'Chapter 2', '1.png'), png);
    const loose = path.join(library, 'Loose.cbz');
    await fs.writeFile(loose, zip([{ name: '1.png', bytes: png }]));
    selected = library;
    const added = await call('add-library-folder');
    assert.equal(added.added, 3);
    assert.deepEqual(await call('library-folders'), [await fs.realpath(library)]);
    const linked = (await call('list')).filter((item) => item.linked);
    assert.equal(linked.length, 3);
    assert.deepEqual(
      linked.filter((item) => item.series === 'Series A').map((item) => item.title),
      ['Chapter 1', 'Chapter 2'],
    );
    const first = linked.find((item) => item.title === 'Chapter 1');
    assert.deepEqual(Buffer.from((await call('page', first.id, 0)).bytes), png);
    const managedEntries = await fs.readdir(path.join(root, 'local-archives', owner, first.id));
    assert.deepEqual(managedEntries, ['manifest.json'], 'Read in place: nothing is copied');

    // The archive changed on disk: refused until rescanned, then read again under its id.
    await fs.writeFile(
      chapterOne,
      zip([
        { name: '1.png', bytes: png },
        { name: '2.png', bytes: png },
      ]),
    );
    await assert.rejects(call('page', first.id, 0), /could not be loaded/);
    await fs.rm(loose);
    const rescanned = await call('rescan');
    assert.deepEqual([rescanned.added, rescanned.removed], [1, 1]);
    const updated = (await call('list')).find((item) => item.id === first.id);
    assert.equal(updated.pageCount, 2);
    await call('page', first.id, 1);

    // Removing a comic or the folder never touches the files themselves.
    await call('remove', first.id);
    assert.ok((await fs.stat(chapterOne)).isFile());
    await assert.rejects(call('remove-library-folder', path.join(root, 'elsewhere')), /Unknown/);
    await call('remove-library-folder', await fs.realpath(library));
    assert.equal((await call('list')).filter((item) => item.linked).length, 0);
    assert.ok((await fs.stat(path.join(series, 'Chapter 2', '1.png'))).isFile());

    // Dropped on the window: an absolute path only, through the same checked import.
    for (const bad of [undefined, 42, '', 'relative.cbz', `${root} x.cbz`, 'x'.repeat(5000)])
      await assert.rejects(call('import-dropped', bad), /Drop a comic/, String(bad));
    await assert.rejects(call('import-dropped', path.join(root, 'missing.cbz')));
    assert.equal((await call('import-dropped', path.join(root, 'volume.zip'))).series, 'Frieren');

    // Opened from outside the app: queued by main, collected by the page.
    assert.equal(await call('open-pending'), null);
    archives.queueComicOpen(path.join(root, 'volume.zip'));
    archives.queueComicOpen('relative.cbz');
    assert.equal((await call('open-pending')).title, 'Frieren #3');
    assert.equal(await call('open-pending'), null);
    assert.deepEqual(
      archives.comicPathsFromArgs([
        'app.exe',
        '--pm-background-start',
        path.join(root, 'a.cbz'),
        'relative.cbz',
        path.join(root, 'notes.txt'),
      ]),
      [path.join(root, 'a.cbz')],
    );
  } finally {
    Module._load = originalLoad;
    delete require.cache[modulePath];
    await fs.rm(root, { recursive: true, force: true });
  }
});
