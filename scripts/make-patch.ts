/**
 * Builds the toy patch package: `dist/patch/Coopanion-Toy-Patch-<app version>-v<n>.zip`.
 *
 * The patch carries only the desktop pet World's changed files. The app ships that package as plain
 * files under `resources/app/node_modules/cortico-world-desktop-pet` (electron-builder packs with
 * `asar: false`; the Core runs its TypeScript through tsx), so an official install gets the feature
 * by overwriting files — no installer build, no repackaging.
 *
 * The zip holds `payload/` (the files, laid out as the install directory has them), `manifest.json`
 * (each shipped file's sha256, and the sha256 it had in the base version), `release-id.txt` (pins
 * the manifest bytes), `setup.ps1` + `Install.cmd`/`Uninstall.cmd`/`Check.cmd` (see installer/patch/)
 * and `使用说明.txt`. setup.ps1 checks the recorded hashes before it touches anything, so a patch
 * made for one app version refuses to half-apply on another, and uninstalling refuses to clobber
 * host files that changed since. The bundle shape follows Window-Perch-Setup's
 * Install/Uninstall/Check trio.
 *
 * Run on the feature branch, with the upstream release it targets already merged in and the tree
 * clean:
 *
 *   pnpm exec tsx scripts/make-patch.ts --base v0.1.27 [--patch-version 1] [--out dist/patch]
 *
 * `--drop-extra` drops changes outside the World package instead of failing on them: a branch that
 * also publishes custom installers carries release bookkeeping (root package.json version,
 * docs/releases), and none of that belongs in a patch.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync, type Zippable } from 'fflate';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
/** The World package: repository-relative, and the path it lives under in an installed app. */
const PACKAGE = 'packages/cortico-world-desktop-pet';
const INSTALLED = 'node_modules/cortico-world-desktop-pet';
/** scripts/pack.ts does not ship `tests/`, so a patch has nothing to change there. */
const NOT_SHIPPED = `${PACKAGE}/tests/`;
/** Templates the zip carries beside the overlay; see installer/patch/. */
const TEMPLATES = join(ROOT, 'installer', 'patch');

interface Options {
  base: string;
  patchVersion: string;
  out: string;
  dropExtra: boolean;
  allowDirty: boolean;
}

function parseArgs(argv: readonly string[]): Options {
  const opts: Options = { base: '', patchVersion: '1', out: join(ROOT, 'dist', 'patch'), dropExtra: false, allowDirty: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--base') opts.base = argv[++i] ?? '';
    else if (arg === '--patch-version') opts.patchVersion = argv[++i] ?? '';
    else if (arg === '--out') opts.out = argv[++i] ?? '';
    else if (arg === '--drop-extra') opts.dropExtra = true;
    else if (arg === '--allow-dirty') opts.allowDirty = true;
    else throw new Error(`不认识这个参数:${arg}`);
  }
  if (!opts.base) throw new Error('用法: tsx scripts/make-patch.ts --base <官方发布 tag,如 v0.1.27> [--patch-version 1] [--out dist/patch] [--drop-extra] [--allow-dirty]');
  if (!/^v?\d/.test(opts.base)) throw new Error(`--base 要指向官方发布 tag(如 v0.1.27),收到「${opts.base}」`);
  if (!/^[A-Za-z0-9._-]+$/.test(opts.patchVersion)) throw new Error(`--patch-version 只允许字母数字与 . _ -,收到「${opts.patchVersion}」`);
  return opts;
}

const git = (...args: string[]): string =>
  execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 30 }).trim();
const gitBytes = (...args: string[]): Buffer =>
  execFileSync('git', args, { cwd: ROOT, maxBuffer: 1 << 30 });
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** The blob of `path` in `rev`, or null when that revision has no such file. */
function blobAt(rev: string, path: string): Buffer | null {
  try {
    return execFileSync('git', ['cat-file', 'blob', `${rev}:${path}`], { cwd: ROOT, maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

interface Entry {
  /** Install-relative path, forward slashes. */
  path: string;
  /** The file's sha256, absent when the patch removes it. */
  sha256: string | null;
  bytes: number;
  /** The file's sha256 in the base version; null when the base has no such file. */
  baseSha256: string | null;
  removed: boolean;
  /** The overlay file to write into the zip, absent when the patch removes the file. */
  content: Uint8Array | null;
}

const utf8 = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'utf8'));
/** PowerShell reads a script as ANSI unless it carries a BOM; the templates hold Chinese text. */
const withBom = (text: string): Uint8Array => new Uint8Array(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]));

function main(): void {
  const opts = parseArgs(process.argv.slice(2));

  git('rev-parse', '--verify', `${opts.base}^{commit}`);
  const ancestor = (() => {
    try { execFileSync('git', ['merge-base', '--is-ancestor', opts.base, 'HEAD'], { cwd: ROOT }); return true; } catch { return false; }
  })();
  if (!ancestor) throw new Error(`${opts.base} 不是 HEAD 的祖先:先把那次官方发布合并进当前分支,tag 打错了吗?`);
  const dirty = git('status', '--porcelain');
  if (dirty && !opts.allowDirty) throw new Error(`工作区不干净,先提交(--allow-dirty 会按现在的工作区文件打包):\n${dirty}`);
  if (dirty) console.log('警告:工作区有未提交的改动,补丁按现在的工作区文件打包');

  const baseVersion = (JSON.parse(git('show', `${opts.base}:package.json`)) as { version: string }).version;

  const changed = git('diff', '--name-status', '--no-renames', opts.base, 'HEAD')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [status, ...rest] = line.split('\t');
      return { status: status!, path: rest.join('\t') };
    });

  const shipped = changed.filter((c) => c.path.startsWith(`${PACKAGE}/`) && !c.path.startsWith(NOT_SHIPPED));
  const extra = changed.filter((c) => !c.path.startsWith(`${PACKAGE}/`) || c.path.startsWith(NOT_SHIPPED));
  if (extra.length) {
    const list = extra.map((c) => `  ${c.status}  ${c.path}`).join('\n');
    if (!opts.dropExtra) {
      throw new Error(`相对 ${opts.base} 还有世界包之外的改动,它们不会进补丁:\n${list}\n`
        + '补丁只装世界包;这些改动该合并进上游、或留在自定义安装版里。确认要丢掉它们时加 --drop-extra。');
    }
    console.log(`警告:丢掉 ${extra.length} 个世界包之外的改动(不进补丁):\n${list}`);
  }

  const entries: Entry[] = [];
  for (const c of shipped) {
    const rel = c.path.slice(PACKAGE.length + 1);
    const installPath = `${INSTALLED}/${rel}`;
    const baseBlob = blobAt(opts.base, c.path);
    const baseSha256 = baseBlob ? sha256(baseBlob) : null;
    if (c.status === 'D') {
      entries.push({ path: installPath, sha256: null, bytes: 0, baseSha256, removed: true, content: null });
      continue;
    }
    const content = readFileSync(join(ROOT, c.path));
    entries.push({ path: installPath, sha256: sha256(content), bytes: content.length, baseSha256, removed: false, content: new Uint8Array(content) });
  }
  if (!entries.length) throw new Error(`相对 ${opts.base} 世界包没有任何改动:没有可打的补丁`);

  const patchId = `toy-${baseVersion}-v${opts.patchVersion}`;
  const manifest = {
    schema: 1,
    patchId,
    patchVersion: opts.patchVersion,
    createdAt: new Date().toISOString(),
    name: 'Coopanion toy patch',
    comment: '桌宠的玩具:只覆盖桌面宠物 World 的文件;setup.ps1 逐文件核对基准版本的 sha256。',
    app: { name: 'Coopanion', platform: 'win32-x64', version: baseVersion, tag: opts.base, package: PACKAGE },
    files: entries.map(({ content: _content, ...rest }) => rest),
  };

  const zip: Zippable = {};
  for (const entry of entries) {
    if (entry.content) zip[`payload/${entry.path}`] = entry.content;
  }
  const manifestBytes = utf8(`${JSON.stringify(manifest, null, 2)}\n`);
  zip['manifest.json'] = manifestBytes;
  // Mirror of Window-Perch's release-id.txt: pins the manifest bytes; setup.ps1 verifies both this
  // and the per-file hashes inside the manifest before it touches the app.
  zip['release-id.txt'] = utf8(`${sha256(manifestBytes).slice(0, 16)}\n`);
  zip['setup.ps1'] = withBom(readFileSync(join(TEMPLATES, 'setup.ps1'), 'utf8'));
  zip['Install.cmd'] = readFileSync(join(TEMPLATES, 'Install.cmd'));
  zip['Uninstall.cmd'] = readFileSync(join(TEMPLATES, 'Uninstall.cmd'));
  zip['Check.cmd'] = readFileSync(join(TEMPLATES, 'Check.cmd'));
  const tokens = { patchId, appVersion: baseVersion, createdAt: manifest.createdAt.slice(0, 10) };
  zip['使用说明.txt'] = withBom(readFileSync(join(TEMPLATES, '使用说明.txt'), 'utf8')
    .replace(/\{\{(\w+)\}\}/g, (m, key: string) => tokens[key as keyof typeof tokens] ?? m));

  mkdirSync(opts.out, { recursive: true });
  const file = join(opts.out, `Coopanion-Toy-Patch-${baseVersion}-v${opts.patchVersion}.zip`);
  if (existsSync(file)) throw new Error(`${file} 已存在:换一个 --patch-version`);
  const bytes = zipSync(zip, { level: 6 });
  writeFileSync(file, bytes);
  writeFileSync(`${file}.sha256`, `${sha256(bytes)}  ${file.split(/[\\/]/).pop()}\n`);

  const size = (n: number) => `${(n / 1024).toFixed(1)} KB`;
  for (const entry of entries) console.log(`${entry.removed ? '删除' : '写入'}  ${entry.path}  ${size(entry.bytes)}`);
  console.log(`补丁 ${patchId}:${entries.length} 个文件,${size(bytes.length)},基准 v${baseVersion}`);
  console.log(`→ ${file}`);
}

main();
