const fs = require('fs');
const path = require('path');

// Copy manifest and static files to dist
const filesToCopy = ['manifest.json', 'popup.html'];

filesToCopy.forEach(file => {
  const src = path.join(__dirname, file);
  const dest = path.join(__dirname, 'dist', file);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dest);
    console.log(`Copied ${file} to dist/`);
  }
});

// Copy asset directories (icons, self-hosted fonts) if they exist
['icons', 'fonts'].forEach(dirName => {
  const srcDir = path.join(__dirname, dirName);
  const destDir = path.join(__dirname, 'dist', dirName);
  if (!fs.existsSync(srcDir)) return;
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
  fs.readdirSync(srcDir).forEach(file => {
    fs.copyFileSync(path.join(srcDir, file), path.join(destDir, file));
  });
  console.log(`Copied ${dirName}/ to dist/`);
});

// Strip export statements from compiled files (needed for Chrome extension scripts)
const filesToClean = ['content.js', 'background.js', 'popup.js'];
const distDir = path.join(__dirname, 'dist');

filesToClean.forEach(file => {
  const filePath = path.join(distDir, file);
  if (fs.existsSync(filePath)) {
    let content = fs.readFileSync(filePath, 'utf8');
    // Remove all export statements
    content = content.replace(/export\s+\{[^}]*\};?\s*$/gm, '').replace(/export\s+\*\s+from\s+[^;]+;/gm, '');
    fs.writeFileSync(filePath, content);
  }
});

// Copy everything from dist to the extension folder. It lives inside the repo
// (git-ignored), not beside it: `..` dropped the build wherever the checkout's
// parent happened to be, and every worktree overwrote the same folder.
const extensionDir = path.join(__dirname, 'review-atlas-extension');
// Create it rather than skipping: on a fresh clone this directory does not
// exist, so the copy was silently skipped and `Load unpacked` had nothing to
// point at — even though the README tells you to select exactly this folder.
if (!fs.existsSync(extensionDir)) fs.mkdirSync(extensionDir, { recursive: true });
{
  fs.readdirSync(distDir).forEach(file => {
    const src = path.join(distDir, file);
    const dest = path.join(extensionDir, file);
    // cpSync recurses; the previous hand-rolled copy only handled one level of
    // nesting and threw ENOTSUP on any directory inside a directory.
    fs.cpSync(src, dest, { recursive: true });
  });
  console.log('Copied files to review-atlas-extension/');
}

console.log('Build complete!');
