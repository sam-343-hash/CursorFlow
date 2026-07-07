/**
 * test/validate-manifest.js
 *
 * Catches the most common "why won't Chrome load this" failure modes
 * BEFORE ever opening chrome://extensions:
 *  1. manifest.json is invalid JSON.
 *  2. Any file path referenced in manifest.json doesn't actually exist.
 *  3. Any .js file in the project has a syntax error.
 *  4. background.js's self-healing injection file list has silently
 *     drifted out of sync with manifest.json's content_scripts list
 *     (these are intentionally duplicated - see the comment in
 *     background.js explaining why - so this check exists specifically
 *     to catch that duplication going stale).
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const projectRoot = path.join(__dirname, '..');
let pass = 0, fail = 0;
function check(name, condition, details) {
  if (condition) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}`); if (details) console.log(`      ${details}`); }
}

// --- 1. manifest.json is valid JSON --------------------------------------
let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, 'manifest.json'), 'utf8'));
  check('manifest.json is valid JSON', true);
} catch (e) {
  check('manifest.json is valid JSON', false, e.message);
  console.log('\nCannot continue further checks without a valid manifest.json.');
  process.exit(1);
}

// --- 2. Every file path referenced in manifest.json exists ----------------
function fileExists(relPath) {
  return fs.existsSync(path.join(projectRoot, relPath));
}

const referencedFiles = [];
if (manifest.action && manifest.action.default_popup) referencedFiles.push(manifest.action.default_popup);
if (manifest.action && manifest.action.default_icon) referencedFiles.push(...Object.values(manifest.action.default_icon));
if (manifest.icons) referencedFiles.push(...Object.values(manifest.icons));
if (manifest.options_ui && manifest.options_ui.page) referencedFiles.push(manifest.options_ui.page);
if (manifest.background && manifest.background.service_worker) referencedFiles.push(manifest.background.service_worker);
if (Array.isArray(manifest.content_scripts)) {
  for (const block of manifest.content_scripts) {
    if (Array.isArray(block.js)) referencedFiles.push(...block.js);
    if (Array.isArray(block.css)) referencedFiles.push(...block.css);
  }
}

const missingFiles = referencedFiles.filter((f) => !fileExists(f));
check(
  `All ${referencedFiles.length} files referenced in manifest.json exist on disk`,
  missingFiles.length === 0,
  missingFiles.length ? `Missing: ${missingFiles.join(', ')}` : ''
);

// Also check every HTML page's own <script src> / <link href> references
// resolve to real files - manifest.json only lists top-level pages, not
// what those pages load internally.
function extractLocalRefs(htmlContent) {
  const refs = [];
  const scriptRegex = /<script[^>]+src=["']([^"']+)["']/g;
  const linkRegex = /<link[^>]+href=["']([^"']+)["']/g;
  let m;
  while ((m = scriptRegex.exec(htmlContent))) refs.push(m[1]);
  while ((m = linkRegex.exec(htmlContent))) refs.push(m[1]);
  return refs;
}

const htmlFiles = [
  manifest.action && manifest.action.default_popup,
  manifest.options_ui && manifest.options_ui.page,
  'src/ui/voice/voice.html',
].filter(Boolean);

let allHtmlRefsOk = true;
const htmlRefDetails = [];
for (const htmlRelPath of htmlFiles) {
  const htmlAbsPath = path.join(projectRoot, htmlRelPath);
  if (!fs.existsSync(htmlAbsPath)) continue;
  const content = fs.readFileSync(htmlAbsPath, 'utf8');
  const refs = extractLocalRefs(content);
  const htmlDir = path.dirname(htmlAbsPath);
  for (const ref of refs) {
    if (ref.startsWith('http')) continue; // external CDN links are fine, not checked here
    const resolved = path.join(htmlDir, ref);
    if (!fs.existsSync(resolved)) {
      allHtmlRefsOk = false;
      htmlRefDetails.push(`${htmlRelPath} references missing "${ref}"`);
    }
  }
}
check('Every <script>/<link> reference inside HTML pages resolves to a real file', allHtmlRefsOk, htmlRefDetails.join('\n'));

// --- 3. Every .js file in the project has valid syntax ----------------------
function findJsFiles(dir) {
  let results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) results = results.concat(findJsFiles(fullPath));
    else if (entry.name.endsWith('.js')) results.push(fullPath);
  }
  return results;
}

const allJsFiles = findJsFiles(path.join(projectRoot, 'src'));
let syntaxErrors = [];
for (const file of allJsFiles) {
  try {
    execSync(`node --check "${file}"`, { stdio: 'pipe' });
  } catch (e) {
    syntaxErrors.push(`${path.relative(projectRoot, file)}: ${e.stderr.toString().split('\n')[0]}`);
  }
}
check(`All ${allJsFiles.length} .js files under src/ have valid syntax`, syntaxErrors.length === 0, syntaxErrors.join('\n'));

// --- 4. background.js's injection file list matches manifest.json exactly --
const backgroundSource = fs.readFileSync(path.join(projectRoot, 'src/background/background.js'), 'utf8');
const arrayMatch = backgroundSource.match(/const CONTENT_SCRIPT_FILES = \[([\s\S]*?)\];/);
let backgroundFileList = [];
if (arrayMatch) {
  backgroundFileList = arrayMatch[1]
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}
const manifestFileList = (manifest.content_scripts && manifest.content_scripts[0] && manifest.content_scripts[0].js) || [];

const sameLength = backgroundFileList.length === manifestFileList.length;
const sameOrder = sameLength && backgroundFileList.every((f, i) => f === manifestFileList[i]);
check(
  'background.js CONTENT_SCRIPT_FILES matches manifest.json content_scripts.js exactly (same files, same order)',
  sameOrder,
  sameOrder ? '' : `background.js: ${JSON.stringify(backgroundFileList)}\nmanifest.json: ${JSON.stringify(manifestFileList)}`
);

console.log('');
console.log(`RESULT: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
