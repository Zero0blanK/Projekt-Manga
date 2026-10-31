const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  comicDisplayTitle,
  epubPageOrder,
  parseComicInfo,
} = require('../dist/main/local-archive-formats.js');

test('ComicInfo.xml gives the series, number and writer', () => {
  const info = parseComicInfo(`<?xml version="1.0"?>
<ComicInfo xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <Series>Frieren &amp; Friends</Series>
  <Number>12</Number>
  <Title>The Journey&#39;s End</Title>
  <Writer>Kanehito Yamada</Writer>
  <Genre>Fantasy, Adventure; Drama</Genre>
  <Summary>  A long
    summary.  </Summary>
</ComicInfo>`);
  assert.deepEqual(info, {
    series: 'Frieren & Friends',
    number: '12',
    title: "The Journey's End",
    writer: 'Kanehito Yamada',
    summary: 'A long summary.',
    genres: ['Fantasy', 'Adventure', 'Drama'],
  });
  assert.equal(comicDisplayTitle(info, 'file'), "Frieren & Friends #12 · The Journey's End");
  assert.equal(comicDisplayTitle(null, 'file name'), 'file name');
});

test('ComicInfo.xml with entities, a DOCTYPE or no ComicInfo root is ignored', () => {
  const laughs = `<?xml version="1.0"?>
<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;">]>
<ComicInfo><Series>&lol2;</Series></ComicInfo>`;
  assert.equal(parseComicInfo(laughs), null);
  const external = `<!DOCTYPE x [<!ENTITY secret SYSTEM "file:///etc/passwd">]>
<ComicInfo><Title>&secret;</Title></ComicInfo>`;
  assert.equal(parseComicInfo(external), null);
  assert.equal(parseComicInfo('<Other><Series>x</Series></Other>'), null);
  assert.equal(parseComicInfo('<ComicInfo></ComicInfo>'), null);
  assert.equal(
    parseComicInfo(`<ComicInfo><Series>${'x'.repeat(70_000)}</Series></ComicInfo>`),
    null,
  );
  // Control characters from numeric references are dropped, not decoded.
  assert.equal(parseComicInfo('<ComicInfo><Series>a&#7;b</Series></ComicInfo>').series, 'ab');
});

test('EPUB pages follow the spine, each image once, the rest after', () => {
  const opf = `<package><manifest>
    <item id="p2" href="text/page2.xhtml" media-type="application/xhtml+xml"/>
    <item id="p1" href="text/page1.xhtml" media-type="application/xhtml+xml"/>
    <item id="cover" href="images/cover.jpg" media-type="image/jpeg"/>
  </manifest><spine><itemref idref="cover"/><itemref idref="p1"/><itemref idref="p2"/></spine></package>`;
  const documents = new Map([
    ['OEBPS/content.opf', opf],
    [
      'OEBPS/text/page1.xhtml',
      '<img src="../images/b%20page.jpg"/><img src="../images/cover.jpg"/>',
    ],
    [
      'OEBPS/text/page2.xhtml',
      '<svg><image xlink:href="../images/a.png"/></svg><img src="https://evil.test/x.jpg"/>',
    ],
  ]);
  const images = [
    'OEBPS/images/a.png',
    'OEBPS/images/b page.jpg',
    'OEBPS/images/cover.jpg',
    'OEBPS/images/unused-10.jpg',
    'OEBPS/images/unused-2.jpg',
  ];
  assert.deepEqual(epubPageOrder(images, documents), [
    'OEBPS/images/cover.jpg',
    'OEBPS/images/b page.jpg',
    'OEBPS/images/a.png',
    'OEBPS/images/unused-2.jpg',
    'OEBPS/images/unused-10.jpg',
  ]);
  // No package document: natural order.
  assert.deepEqual(epubPageOrder(['p10.jpg', 'p2.jpg'], new Map()), ['p2.jpg', 'p10.jpg']);
});

test('orders an EPUB of thousands of images quickly', () => {
  // An untrusted archive with 20,000 images, each referenced twice by one spine page:
  // checking for repeats by scanning the list would take hundreds of millions of steps.
  const images = Array.from({ length: 20_000 }, (_, i) => `img/p${i}.jpg`);
  const page = images.map((name) => `<img src="${name}"/><img src="${name}"/>`).join('');
  const documents = new Map([
    ['content.opf', '<item id="c" href="page.xhtml"/><itemref idref="c"/>'],
    ['page.xhtml', page],
  ]);
  const started = Date.now();
  const ordered = epubPageOrder(images, documents);
  assert.equal(ordered.length, images.length);
  assert.equal(ordered[1], 'img/p1.jpg');
  assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`);
});
