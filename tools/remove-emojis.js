#!/usr/bin/env node
/**
 * Node.js script to remove all emojis from project files recursively
 * Usage: node remove-emojis.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename  = fileURLToPath(import.meta.url);
const __dirname   = path.dirname(__filename);
const SCRIPT_PATH = path.resolve(__filename);     // prevent seppuku

/* Emoji matching
 *   ------------------------------------------------------------------
 *   - EMOJI_RE            : non-global, cheap “does this file contain any?”
 *   - EMOJI_RE_GLOBAL     : global, used for the actual replacement
 *   - EMOJI_CONTROL_RE_G  : (optional) variation selectors / ZWJ cleanup
 */
const EMOJI_RE              = /\p{Extended_Pictographic}/u;
const EMOJI_RE_GLOBAL       = /\p{Extended_Pictographic}/gu;
const EMOJI_CONTROL_RE_G    = /[\u200D\uFE0E\uFE0F]/g; // ← comment out if unwanted

const EXTENSIONS = ['.js', '.sh', '.ts', '.json', '.md', '.mdx', '.txt', '.sol', '.yml', '.yaml'];
const SKIP_DIRS  = ['node_modules', '.git', 'out', 'cache', 'build', 'dist', '.next'];

let processedFiles    = 0;
let totalReplacements = 0;

// Helpers

const shouldSkipDir = dirPath =>
SKIP_DIRS.some(skip => dirPath.includes(skip));

const hasEmojiQuick = content =>
EMOJI_RE.test(content);                       // non-stateful

//  Core

function processFile(filePath) {
    try {
        const original  = fs.readFileSync(filePath, 'utf8');
        let   content   = original;

        const matches   = content.match(EMOJI_RE_GLOBAL); // array or null
        if (!matches) return;                              // nothing to do

        content = content
        .replace(EMOJI_RE_GLOBAL, '')          // strip the emoji
        .replace(EMOJI_CONTROL_RE_G, '');      // strip residual ZWJ/VS

        fs.writeFileSync(filePath + '.bak', original);     // backup
        fs.writeFileSync(filePath,         content);       // overwrite

        console.log(`[PROCESSED] ${filePath} – ${matches.length} emojis removed`);
        processedFiles++;
        totalReplacements += matches.length;
    } catch (err) {
        console.error(`[ERROR] Failed to process ${filePath}: ${err.message}`);
    }
}

function walkDir(dir) {
    for (const item of fs.readdirSync(dir)) {
        const full = path.join(dir, item);
        const stat = fs.statSync(full);

        if (stat.isDirectory()) {
            if (!shouldSkipDir(full)) walkDir(full);
            continue;
        }

        if (!stat.isFile())                         continue;
        if (path.resolve(full) === SCRIPT_PATH)     continue; // skip self
        if (full.endsWith('.bak'))                  continue; // skip backups
        if (!EXTENSIONS.includes(path.extname(item))) continue;

        const data = fs.readFileSync(full, 'utf8');
        if (hasEmojiQuick(data)) processFile(full);
    }
}

function verifyRemoval() {
    console.log('[VERIFY] Checking for any remaining emojis …');
    const leftovers = [];

    (function check(dir) {
        for (const item of fs.readdirSync(dir)) {
            const full = path.join(dir, item);
            const stat = fs.statSync(full);

            if (stat.isDirectory()) {
                if (!shouldSkipDir(full)) check(full);
            } else if (stat.isFile()) {
                if (path.resolve(full) === SCRIPT_PATH || full.endsWith('.bak')) continue;
                if (!EXTENSIONS.includes(path.extname(item)))                    continue;

                const data = fs.readFileSync(full, 'utf8');
                if (hasEmojiQuick(data)) leftovers.push(full);
            }
        }
    })('.');

    if (leftovers.length) {
        console.log('[WARNING] Some files still contain emojis:');
        leftovers.forEach(f => console.log(`  ${f}`));
    } else {
        console.log('[SUCCESS] No emojis found in remaining files');
    }
}

//  Main

function main() {
    console.log('[START] Removing all emojis from project files …');
    walkDir('.');
    verifyRemoval();

    console.log('\n[COMPLETE] Emoji removal finished!');
    console.log(`  Files processed:      ${processedFiles}`);
    console.log(`  Total emojis removed: ${totalReplacements}`);
    console.log('\n[INFO] Backup files (.bak) created for each modified file.');
    console.log('      Remove:  find . -name "*.bak" -delete');
    console.log('   Restore:  find . -name "*.bak" -exec sh -c \'mv "$1" "${1%.bak}"\' _ {} \\;');
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main();
}
