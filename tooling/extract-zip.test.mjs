import assert from 'node:assert/strict';
import { createWriteStream } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile, lstat, rm, symlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import test from 'node:test';
import yazl from 'yazl';

// Exercise the actual transitive dependency used by Electron Forge packaging.
const desktop = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const forge = createRequire(desktop.resolve('@electron-forge/cli/package.json'));
const core = createRequire(forge.resolve('@electron-forge/core/package.json'));
const packager = createRequire(core.resolve('@electron/packager/package.json'));
const extract = packager('extract-zip');
const scratch = fileURLToPath(new URL('../tmp/', import.meta.url));

async function fixture(t, entries) {
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(path.join(scratch, 'extract-zip-test-'));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(scratch));
    assert.ok(path.basename(root).startsWith('extract-zip-test-'));
    await rm(root, { recursive: true, force: true });
  });
  const dir = path.join(root, 'output');
  await mkdir(dir);
  const archive = path.join(root, 'fixture.zip');
  const zip = new yazl.ZipFile();
  for (const entry of entries(root)) {
    zip.addBuffer(Buffer.from(entry.content), entry.name, { mode: entry.mode ?? 0o100644 });
  }
  const written = pipeline(zip.outputStream, createWriteStream(archive));
  zip.end();
  await written;
  return { root, dir, archive };
}

async function canSymlink(t, dir) {
  try {
    const probe = path.join(dir, 'symlink-probe');
    await symlink('target', probe);
    await rm(probe);
    return true;
  } catch (error) {
    if (process.platform !== 'win32' || error.code !== 'EPERM') throw error;
    t.skip('Windows account lacks symlink creation privileges; Linux/macOS run this regression.');
    return false;
  }
}

test('extracts nested files and replaces ordinary files', async t => {
  const f = await fixture(t, () => [{ name: 'nested/file.txt', content: 'new' }]);
  await mkdir(path.join(f.dir, 'nested'));
  await writeFile(path.join(f.dir, 'nested/file.txt'), 'old');
  await extract(f.archive, { dir: f.dir });
  assert.equal(await readFile(path.join(f.dir, 'nested/file.txt'), 'utf8'), 'new');
});

for (const absolute of [false, true]) {
  test(`rejects ${absolute ? 'absolute' : 'relative'} escaping archive symlinks before creation`, async t => {
    const f = await fixture(t, root => [
      { name: 'escape', content: absolute ? path.join(root, 'outside.txt') : '../outside.txt', mode: 0o120777 },
      { name: 'escape', content: 'overwritten' }
    ]);
    await writeFile(path.join(f.root, 'outside.txt'), 'unchanged');
    await assert.rejects(extract(f.archive, { dir: f.dir }), /Out of bound symlink target/);
    assert.equal(await readFile(path.join(f.root, 'outside.txt'), 'utf8'), 'unchanged');
    await assert.rejects(lstat(path.join(f.dir, 'escape')), { code: 'ENOENT' });
  });
}

test('refuses writes through an existing leaf symlink', async t => {
  const f = await fixture(t, () => [{ name: 'escape', content: 'overwritten' }]);
  if (!await canSymlink(t, f.dir)) return;
  await writeFile(path.join(f.root, 'outside.txt'), 'unchanged');
  await symlink('../outside.txt', path.join(f.dir, 'escape'));
  await assert.rejects(extract(f.archive, { dir: f.dir }), /Refusing to write through symlink/);
  assert.equal(await readFile(path.join(f.root, 'outside.txt'), 'utf8'), 'unchanged');
});

test('refuses a duplicate archive file written through an internal symlink', async t => {
  const f = await fixture(t, () => [
    { name: 'target.txt', content: 'unchanged' },
    { name: 'alias', content: 'target.txt', mode: 0o120777 },
    { name: 'alias', content: 'overwritten' }
  ]);
  if (!await canSymlink(t, f.dir)) return;
  await assert.rejects(extract(f.archive, { dir: f.dir }), /Refusing to write through symlink/);
  assert.equal(await readFile(path.join(f.dir, 'target.txt'), 'utf8'), 'unchanged');
});

test('preserves safe relative symlinks required by macOS Electron archives', async t => {
  const f = await fixture(t, () => [
    { name: 'target.txt', content: 'kept' },
    { name: 'alias', content: 'target.txt', mode: 0o120777 }
  ]);
  if (!await canSymlink(t, f.dir)) return;
  await extract(f.archive, { dir: f.dir });
  assert.ok((await lstat(path.join(f.dir, 'alias'))).isSymbolicLink());
  assert.equal(await readFile(path.join(f.dir, 'alias'), 'utf8'), 'kept');
});
