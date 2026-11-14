import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';
import ffmpegStatic from 'ffmpeg-static';

const execFileAsync = promisify(execFile);
const projectRoot = process.cwd();
const publicRoot = path.join(projectRoot, 'public');
const distRoot = path.join(projectRoot, 'dist');
const ffmpegPath = ffmpegStatic;

const imageExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const videoExtensions = new Set(['.mp4', '.mov', '.m4v', '.webm']);

async function walkFiles(dir, output = []) {
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkFiles(fullPath, output);
      continue;
    }

    if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (imageExtensions.has(ext) || videoExtensions.has(ext)) {
        output.push(fullPath);
      }
    }
  }

  return output;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function normalizeMediaName(name) {
  const parsed = path.parse(name);
  const rawBase = parsed.name || name;
  const safeBase = rawBase
    .normalize('NFKC')
    .replace(/[&]/g, ' and ')
    .replace(/[\u2018\u2019\u201B\u2032\u2035'"`]/g, '')
    .replace(/[<>:"/\\|?*%#]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.]+$/g, '')
    .replace(/^[.]+/g, '')
    .trim();

  const base = safeBase || 'asset';
  const ext = parsed.ext ? parsed.ext.replace(/[<>:"/\\|?*%#]+/g, '') : '';
  const finalName = `${base}${ext}`.trim();
  return finalName || 'asset';
}

async function renameWithRetry(oldPath, newPath) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await fs.rename(oldPath, newPath);
      return true;
    } catch (error) {
      if (error && (error.code === 'EBUSY' || error.code === 'EPERM')) {
        await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
        continue;
      }
      throw error;
    }
  }
  return false;
}

async function ensureUniquePath(targetPath, originalPath) {
  if (targetPath === originalPath) return targetPath;
  let candidate = targetPath;
  let counter = 1;

  while (true) {
    try {
      await fs.access(candidate);
      const parsed = path.parse(targetPath);
      candidate = path.join(parsed.dir, `${parsed.name}-${counter}${parsed.ext}`);
      counter += 1;
      if (counter > 500) {
        throw new Error(`Could not generate a unique name for ${targetPath}`);
      }
    } catch {
      return candidate;
    }
  }
}

async function sanitizeMediaTree(rootPath) {
  const renames = [];

  async function walk(currentPath) {
    const entries = await fs.readdir(currentPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__responsive') continue;
        await walk(fullPath);
        const normalizedName = normalizeMediaName(entry.name);
        if (normalizedName !== entry.name) {
          renames.push({
            from: fullPath,
            to: path.join(currentPath, normalizedName),
          });
        }
        continue;
      }

      if (!entry.isFile()) continue;
      const normalizedName = normalizeMediaName(entry.name);
      if (normalizedName !== entry.name) {
        renames.push({
          from: fullPath,
          to: path.join(currentPath, normalizedName),
        });
      }
    }
  }

  await walk(rootPath);

  renames.sort((left, right) => right.from.length - left.from.length);

  for (const rename of renames) {
    const targetPath = await ensureUniquePath(rename.to, rename.from);
    if (targetPath === rename.from) continue;

    try {
      const renamed = await renameWithRetry(rename.from, targetPath);
      if (!renamed) {
        console.warn(`Skipping locked asset rename: ${rename.from} -> ${targetPath}`);
      }
    } catch (error) {
      console.warn(`Skipping asset rename because it could not be completed safely: ${rename.from} -> ${targetPath}`);
      console.warn(error);
    }
  }
}

async function replaceOptimizedFile(filePath, tempPath) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await fs.rm(filePath, { force: true });
      await fs.rename(tempPath, filePath);
      return;
    } catch (error) {
      if (error && (error.code === 'EBUSY' || error.code === 'EPERM')) {
        await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
        continue;
      }
      throw error;
    }
  }

  throw new Error(`File lock could not be released for ${filePath}`);
}

async function optimizeImage(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const stat = await fs.stat(filePath);
  if (stat.size < 10 * 1024 * 1024) return { changed: false, before: stat.size, after: stat.size };

  const metadata = await sharp(filePath).metadata();
  const maxDimension = metadata.width && metadata.height
    ? Math.max(metadata.width, metadata.height)
    : 0;

  if (!maxDimension || maxDimension <= 1400) {
    return { changed: false, before: stat.size, after: stat.size };
  }

  const tempPath = `${filePath}.tmp`;
  const resizeOptions = {
    width: 1400,
    height: 1400,
    fit: 'inside',
    withoutEnlargement: true,
    kernel: 'lanczos3',
  };

  try {
    if (ext === '.png') {
      await sharp(filePath)
        .rotate()
        .resize(resizeOptions)
        .png({ quality: 80, compressionLevel: 9, adaptiveFiltering: true, palette: true })
        .toFile(tempPath);
    } else {
      await sharp(filePath)
        .rotate()
        .resize(resizeOptions)
        .jpeg({ quality: 68, mozjpeg: true, progressive: true, chromaSubsampling: '4:2:0' })
        .toFile(tempPath);
    }

    const tempStat = await fs.stat(tempPath);

    if (tempStat.size >= stat.size * 0.98) {
      await fs.rm(tempPath, { force: true });
      return { changed: false, before: stat.size, after: stat.size };
    }

    try {
      await replaceOptimizedFile(filePath, tempPath);
      return { changed: true, before: stat.size, after: tempStat.size };
    } catch (error) {
      console.warn(`Skipping locked file during optimization: ${filePath}`);
      await fs.rm(tempPath, { force: true });
      return { changed: false, before: stat.size, after: stat.size };
    }
  } catch (error) {
    try {
      await fs.rm(tempPath, { force: true });
    } catch {}
    throw error;
  }
}

async function optimizeVideo(filePath) {
  const stat = await fs.stat(filePath);
  if (stat.size < 40 * 1024 * 1024) {
    return { changed: false, before: stat.size, after: stat.size };
  }

  const tempPath = `${filePath}.tmp.mp4`;
  try {
    await execFileAsync(ffmpegPath, [
      '-hide_banner',
      '-loglevel', 'error',
      '-y',
      '-i', filePath,
      '-vf', "scale='min(1280,iw)':'min(720,ih)':force_original_aspect_ratio=decrease,scale='trunc(iw/2)*2':'trunc(ih/2)*2'",
      '-c:v', 'libx264',
      '-preset', 'medium',
      '-crf', '28',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-movflags', '+faststart',
      tempPath,
    ]);

    const tempStat = await fs.stat(tempPath);

    if (tempStat.size >= stat.size * 0.98) {
      await fs.rm(tempPath, { force: true });
      return { changed: false, before: stat.size, after: stat.size };
    }

    try {
      await replaceOptimizedFile(filePath, tempPath);
      return { changed: true, before: stat.size, after: tempStat.size };
    } catch (error) {
      console.warn(`Skipping locked file during video optimization: ${filePath}`);
      await fs.rm(tempPath, { force: true });
      return { changed: false, before: stat.size, after: stat.size };
    }
  } catch (error) {
    try {
      await fs.rm(tempPath, { force: true });
    } catch {}
    throw error;
  }
}

async function main() {
  await sanitizeMediaTree(publicRoot);

  let ffmpegExists = false;
  if (ffmpegPath) {
    ffmpegExists = await fs.access(ffmpegPath).then(() => true).catch(() => false);
  }

  if (!ffmpegExists) {
    console.warn(`Warning: ffmpeg not found at ${ffmpegPath}, video optimization will be skipped.`);
  }

  const roots = [publicRoot];
  const distExists = await fs.access(distRoot).then(() => true).catch(() => false);
  if (distExists) {
    roots.push(distRoot);
  }

  let imageCount = 0;
  let videoCount = 0;
  let totalBefore = 0;
  let totalAfter = 0;
  let totalSaved = 0;

  for (const root of roots) {
    const files = await walkFiles(root);

    for (const filePath of files) {
      const ext = path.extname(filePath).toLowerCase();
      const beforeStat = await fs.stat(filePath);
      totalBefore += beforeStat.size;

      let result;

      if (imageExtensions.has(ext)) {
        result = await optimizeImage(filePath);
        imageCount += 1;
      } else if (videoExtensions.has(ext)) {
        if (ffmpegExists) {
          result = await optimizeVideo(filePath);
          videoCount += 1;
        } else {
          result = { changed: false, before: beforeStat.size, after: beforeStat.size };
        }
      }

      totalAfter += result ? result.after : beforeStat.size;
      totalSaved += result && result.changed ? (result.before - result.after) : 0;
    }
  }

  console.log(`images=${imageCount} videos=${videoCount}`);
  console.log(`before=${formatBytes(totalBefore)} after=${formatBytes(totalAfter)} saved=${formatBytes(totalSaved)}`);
  console.log(`targetStatus=${totalAfter <= 1400 * 1024 * 1024 ? 'PASS' : 'NEED_MORE_REDUCTION'}`);
}

main().catch((error) => {
  console.error('Optimization failed:', error);
  process.exitCode = 1;
});
