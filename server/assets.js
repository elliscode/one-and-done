import { readdirSync, statSync, existsSync, writeFileSync, renameSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const ASSET_FOLDERS = ['backgrounds', 'tokens', 'images', 'handouts'];
export const MAX_ASSET_BYTES = 15 * 1024 * 1024;
const NAME_RE = /^[a-z0-9][a-z0-9._-]*\.(png|jpe?g|gif|webp|svg)$/;

export class AssetError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// "My Map (v2).PNG" -> "my-map-v2.png"
export function sanitizeAssetName(name) {
  const base = String(name ?? '').split(/[\\/]/).pop().trim().toLowerCase();
  const m = base.match(/^(.*?)(\.[a-z0-9]+)?$/);
  const stem = (m[1] || '').replace(/\s+/g, '-').replace(/[^a-z0-9._-]/g, '').replace(/^[._-]+/, '').replace(/-+/g, '-');
  const out = `${stem}${m[2] ?? ''}`;
  if (!NAME_RE.test(out) || out.includes('..')) throw new AssetError('Use a .png, .jpg, .gif, .webp or .svg file with a simple name');
  return out;
}

// Check the bytes really are the image type the extension claims.
function matchesType(name, buf) {
  const ext = name.split('.').pop();
  const head = buf.subarray(0, 16);
  switch (ext) {
    case 'png': return head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case 'jpg': case 'jpeg': return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
    case 'gif': return head.subarray(0, 4).toString('latin1') === 'GIF8';
    case 'webp': return head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP';
    case 'svg': return /<svg[\s>]/i.test(buf.subarray(0, 4096).toString('utf8'));
    default: return false;
  }
}

export function createAssetStore(staticDir) {
  const checkFolder = (folder) => {
    if (!ASSET_FOLDERS.includes(folder)) throw new AssetError(`Unknown folder "${folder}"`, 404);
    return join(staticDir, folder);
  };

  return {
    // usage: (path) => number of references
    list(usage = () => 0) {
      const out = {};
      for (const folder of ASSET_FOLDERS) {
        const dir = join(staticDir, folder);
        out[folder] = existsSync(dir) ? readdirSync(dir).filter((f) => NAME_RE.test(f)).sort().map((f) => {
          const st = statSync(join(dir, f));
          const path = `/static/${folder}/${f}`;
          return { name: f, path, size: st.size, mtime: st.mtimeMs, usedBy: usage(path) };
        }) : [];
      }
      return out;
    },

    paths() {
      const l = this.list();
      return Object.fromEntries(ASSET_FOLDERS.map((f) => [f, l[f].map((a) => a.path)]));
    },

    save(folder, rawName, buf, { overwrite = false } = {}) {
      const dir = checkFolder(folder);
      const name = sanitizeAssetName(rawName);
      if (!Buffer.isBuffer(buf) || !buf.length) throw new AssetError('Empty upload');
      if (buf.length > MAX_ASSET_BYTES) throw new AssetError('File is larger than 15 MB', 413);
      if (!matchesType(name, buf)) throw new AssetError(`That file's contents don't look like a .${name.split('.').pop()} image`);
      const file = join(dir, name);
      const existed = existsSync(file);
      if (existed && !overwrite) throw new AssetError(`${name} already exists`, 409);
      mkdirSync(dir, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, buf);
      renameSync(tmp, file);
      return { name, path: `/static/${folder}/${name}`, replaced: existed };
    },

    remove(folder, rawName) {
      const dir = checkFolder(folder);
      const name = String(rawName ?? '');
      if (!NAME_RE.test(name) || name.includes('..')) throw new AssetError('Bad file name');
      const file = join(dir, name);
      if (!existsSync(file)) throw new AssetError('File not found', 404);
      unlinkSync(file);
    },
  };
}
