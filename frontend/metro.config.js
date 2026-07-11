const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');
const fs = require('fs');

// ── OneDrive fix ─────────────────────────────────────────────────────────────
// OneDrive Files-On-Demand marks files as NTFS reparse points. Node.js reports
// them as symlinks via fs.readdir {withFileTypes:true}. Metro's crawler stores
// them as symlink entries in its TreeFS, then tries to follow the symlink target
// (which is an internal OneDrive path), fails, and throws "Failed to get SHA-1".
// Patch: intercept readdir and report source-file-extension reparse points as
// regular files, so Metro stores them as real files in its file map.
(function patchReaddirForOneDrive() {
  const orig = fs.readdir;
  const SRC = /\.(ts|tsx|js|jsx|json|css|png|jpg|jpeg|gif|svg|ttf|otf|woff|woff2|mp4|mov|webm|pdf)$/i;

  function fixSymlinks(entries) {
    if (!Array.isArray(entries) || !entries.length || typeof entries[0].isSymbolicLink !== 'function') return;
    for (const e of entries) {
      try {
        if (e.isSymbolicLink() && SRC.test(e.name)) {
          e.isSymbolicLink = () => false;
          e.isFile = () => true;
        }
      } catch (_) {}
    }
  }

  fs.readdir = function (dirPath, options, cb) {
    if (typeof options === 'function') {
      orig.call(fs, dirPath, options);
    } else if (options && options.withFileTypes) {
      orig.call(fs, dirPath, options, (err, entries) => {
        if (!err) fixSymlinks(entries);
        cb(err, entries);
      });
    } else {
      orig.call(fs, dirPath, options, cb);
    }
  };

  // Metro also calls fs.promises.readlink on entries it believes are symlinks.
  // OneDrive reparse points are not real symlinks — readlink throws EINVAL.
  // Intercept and return an empty string so Metro treats them as dead symlinks
  // and falls back to the real file, instead of crashing the transformer.
  const origReadlinkAsync = fs.promises.readlink;
  fs.promises.readlink = async function (filePath, options) {
    try {
      return await origReadlinkAsync.call(fs.promises, filePath, options);
    } catch (err) {
      if (err && (err.code === 'EINVAL' || err.code === 'ENOENT')) return '';
      throw err;
    }
  };
})();

// ── Metro config ─────────────────────────────────────────────────────────────
const config = getDefaultConfig(__dirname);
const srcDir = path.resolve(__dirname, 'src');
const sourceExts = config.resolver.sourceExts || ['ts', 'tsx', 'js', 'jsx', 'json'];

function resolveFile(basePath) {
  try {
    const stat = fs.statSync(basePath);
    if (stat.isFile()) return basePath;
  } catch (_) {}
  for (const ext of sourceExts) {
    try { if (fs.statSync(`${basePath}.${ext}`).isFile()) return `${basePath}.${ext}`; } catch (_) {}
  }
  for (const ext of sourceExts) {
    try { if (fs.statSync(path.join(basePath, `index.${ext}`)).isFile()) return path.join(basePath, `index.${ext}`); } catch (_) {}
  }
  return null;
}

// Node.js built-in polyfills for browser — needed by @twilio/voice-sdk
config.resolver.extraNodeModules = {
  ...config.resolver.extraNodeModules,
  events: path.resolve(__dirname, 'node_modules/events'),
};

// Packages whose "exports" field points to .mjs files that OneDrive serves
// as cloud-only placeholders Metro can't read. Route them to their CJS dist.
const CJS_OVERRIDES = {
  'lucide-react-native':  path.resolve(__dirname, 'node_modules/lucide-react-native/dist/cjs/lucide-react-native.js'),
  'merge-options':        path.resolve(__dirname, 'node_modules/merge-options/index.js'),
  'use-latest-callback':  path.resolve(__dirname, 'node_modules/use-latest-callback/lib/src/index.js'),
  // Force CJS build — ESM version uses getter-only re-exports that break Metro's _interopNamespace
  '@twilio/voice-sdk':    path.resolve(__dirname, 'node_modules/@twilio/voice-sdk/es5/twilio.js'),
};

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (CJS_OVERRIDES[moduleName]) {
    return { type: 'sourceFile', filePath: CJS_OVERRIDES[moduleName] };
  }
  if (moduleName.startsWith('@/')) {
    const resolved = resolveFile(path.resolve(srcDir, moduleName.slice(2)));
    if (resolved) return { type: 'sourceFile', filePath: resolved };
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
