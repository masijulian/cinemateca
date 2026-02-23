const express = require('express');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const https = require('https');

const app = express();
const PORT = 3737;
const DATA_DIR = path.join(__dirname, '../data');
const DATA_FILE = path.join(DATA_DIR, 'library.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, '../frontend/public')));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ────────────────────────────────────────────────
// Config
// ────────────────────────────────────────────────
function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) {
      return { tmdbApiKey: '', watchPaths: [], mpcPath: 'C:\\Program Files\\MPC-HC\\mpc-hc64.exe' };
    }
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (e) {
    return { tmdbApiKey: '', watchPaths: [], mpcPath: 'C:\\Program Files\\MPC-HC\\mpc-hc64.exe' };
  }
}

function saveConfig(cfg) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
}

// ────────────────────────────────────────────────
// Library
// ────────────────────────────────────────────────
const BACKUP_FILE = path.join(DATA_DIR, 'library.backup.json');

function loadLibrary() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  // Try main file first
  if (fs.existsSync(DATA_FILE)) {
    try {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      if (raw.trim().length > 0) return JSON.parse(raw);
    } catch (e) { /* fall through to backup */ }
  }
  return [];
}

function saveLibrary(lib) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  // Atomic write: write to .tmp then rename, so a crash never leaves a 0-byte file
  const tmp = DATA_FILE + '.tmp';
  const json = JSON.stringify(lib, null, 2);
  fs.writeFileSync(tmp, json, 'utf8');
  fs.renameSync(tmp, DATA_FILE);
  // Keep a rolling backup every 50 saves (approximate)
  if (lib.length > 0 && Math.random() < 0.05) {
    try { fs.copyFileSync(DATA_FILE, BACKUP_FILE); } catch (e) {}
  }
}

// ────────────────────────────────────────────────
// Media Unit Scanner
// ────────────────────────────────────────────────
const VIDEO_EXTS = ['.mkv', '.mp4', '.avi', '.mov', '.m4v', '.wmv', '.flv', '.ts', '.m2ts'];

function isVideoFile(name) {
  return VIDEO_EXTS.includes(path.extname(name).toLowerCase());
}

// Collect all video files in a directory and its subdirectories
function collectVideos(dirPath) {
  const results = [];
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        results.push(...collectVideos(fullPath));
      } else if (entry.isFile() && isVideoFile(entry.name)) {
        try {
          const stats = fs.statSync(fullPath);
          results.push({ name: entry.name, path: fullPath, size: stats.size, dir: dirPath });
        } catch (e) { /* skip inaccessible */ }
      }
    }
  } catch (e) { /* skip inaccessible */ }
  return results;
}

// Detect season-like subfolder names: S01, S1, T1, Season 1, Temporada 1, S1940, etc.
function isSeasonLike(name) {
  const n = name.trim();
  return /^(season|temporada)\s*\d+$/i.test(n)   // Season 1, Temporada 2
    || /^s\d{1,4}$/i.test(n)                       // S1, S01, S001, S1940
    || /^t\d{1,2}$/i.test(n)                        // T1, T2 (Temporada)
    || /^serie[s]?\s*\d+$/i.test(n)                 // Serie 1
    || /^part[e]?\s*\d+$/i.test(n)                  // Part 1, Parte 2
    || /\bS\d{4}\b/i.test(n);                       // "... S1940" (decade-based seasons)
}

// Detect subfolders that are supplements (not content), e.g. Extras, Featurettes
function isSupplementFolder(name) {
  return /^(featurettes?|extras?|bonus|specials?|behind\s*the\s*scenes?|deleted\s*scenes?|trailers?|interviews?|subs?|subtitles?|artwork|screenshots?|nfo|covers?|webisodes?|special\s*features?)$/i.test(name.trim());
}

// Build a media unit from a folder that has direct video files
function buildMediaUnit(dirPath, folderName) {
  const allVideos = collectVideos(dirPath);
  // Main file = largest video in the root of this folder
  const rootVideos = allVideos.filter(v => v.dir === dirPath);
  rootVideos.sort((a, b) => b.size - a.size);
  const mainFile = rootVideos[0];
  if (!mainFile) return null;

  const extras = allVideos
    .filter(v => v.path !== mainFile.path)
    .map(v => ({ name: cleanExtraName(v.name), fileName: v.name, path: v.path, size: v.size }));

  const cleanName = cleanFolderName(folderName);
  if (cleanName.length < 2) return null;

  return {
    folderPath: dirPath, folderName, cleanName,
    year: extractYear(folderName),
    mainFile: { name: mainFile.name, path: mainFile.path, size: mainFile.size },
    extras
  };
}

// Extract season number from a folder name
function extractSeasonNumber(name) {
  const m = name.match(/^(?:season|temporada)\s*(\d+)$/i)
    || name.match(/^s(\d{1,4})$/i)
    || name.match(/^t(\d{1,2})$/i)
    || name.match(/\bS(\d{4})\b/i);  // "... S1940" decade-based
  return m ? parseInt(m[1], 10) : 0;
}

// Clean episode filename into a readable name
function cleanEpisodeName(fileName) {
  let n = fileName.replace(/\.[^.]+$/, ''); // remove extension
  // Try to extract episode title after SxxExx pattern
  const epMatch = n.match(/S\d{1,2}E\d{1,3}\s*-?\s*(.*)/i);
  if (epMatch && epMatch[1].trim()) {
    // Clean codec/quality junk from the episode title
    let title = epMatch[1].trim();
    title = title.replace(/\(.*?\)/g, '');
    title = title.replace(/\b(720p|1080p|2160p|bluray|x264|x265|hevc|aac|ac3|dts|10bit)\b.*/gi, '');
    title = title.replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (title.length > 1) return title;
  }
  // Fallback: clean the full filename
  n = n.replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
  return n;
}

// Extract episode number from filename (e.g. S01E03 → 3, or fallback to position)
function extractEpisodeNumber(fileName) {
  const m = fileName.match(/S\d{1,2}E(\d{1,3})/i);
  return m ? parseInt(m[1], 10) : null;
}

// Build a series unit from a folder whose videos live in season subfolders
function buildSeriesUnit(dirPath, folderName) {
  let entries;
  try { entries = fs.readdirSync(dirPath, { withFileTypes: true }); }
  catch (e) { return null; }

  const seasonDirs = entries.filter(e => e.isDirectory() && isSeasonLike(e.name));
  const supplementDirs = entries.filter(e => e.isDirectory() && isSupplementFolder(e.name));

  // Build seasons array with episodes organized per season
  const seasons = [];
  let totalEpisodes = 0;

  for (const sd of seasonDirs) {
    const seasonPath = path.join(dirPath, sd.name);
    const seasonNum = extractSeasonNumber(sd.name);
    const videos = collectVideos(seasonPath);
    if (!videos.length) continue;

    // Sort by episode number or filename
    videos.sort((a, b) => {
      const ea = extractEpisodeNumber(a.name);
      const eb = extractEpisodeNumber(b.name);
      if (ea != null && eb != null) return ea - eb;
      return a.name.localeCompare(b.name);
    });

    const episodes = videos.map((v, idx) => ({
      number: extractEpisodeNumber(v.name) || (idx + 1),
      name: cleanEpisodeName(v.name),
      fileName: v.name,
      path: v.path
    }));

    seasons.push({ number: seasonNum, name: sd.name, episodes });
    totalEpisodes += episodes.length;
  }

  seasons.sort((a, b) => a.number - b.number);

  if (totalEpisodes === 0) return null;

  // Collect extras from supplement folders
  const extras = [];
  for (const sd of supplementDirs) {
    const videos = collectVideos(path.join(dirPath, sd.name));
    for (const v of videos) {
      extras.push({ name: cleanExtraName(v.name), fileName: v.name, path: v.path, size: v.size });
    }
  }

  const mainFile = seasons[0].episodes[0];
  const cleanName = cleanFolderName(folderName);
  if (cleanName.length < 2) return null;

  return {
    folderPath: dirPath, folderName, cleanName,
    year: extractYear(folderName),
    mainFile: { name: mainFile.fileName, path: mainFile.path, size: 0 },
    extras,
    seasons,
    isSeriesFolder: true,
    localEpisodeCount: totalEpisodes
  };
}

// Scan watch paths for "media units" (folders containing video files)
function scanMediaUnits(dirPath, depth = 0) {
  if (depth > 6) return [];

  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch (e) { return []; }

  const folderName = path.basename(dirPath);
  const videoFiles = entries.filter(e => e.isFile() && isVideoFile(e.name));
  const subdirs    = entries.filter(e => e.isDirectory());

  // ── Depth 0 (watch-path root): handle loose video files as individual units ──
  if (depth === 0 && videoFiles.length > 0) {
    const results = [];
    // Each loose video file becomes its own media unit
    for (const vf of videoFiles) {
      const fullPath = path.join(dirPath, vf.name);
      const baseName = vf.name.replace(/\.[^.]+$/, ''); // strip extension
      const cleanName = cleanFolderName(baseName);
      if (cleanName.length < 2) continue;
      try {
        const stats = fs.statSync(fullPath);
        results.push({
          folderPath: fullPath, // use file path as identifier
          folderName: baseName,
          cleanName,
          year: extractYear(baseName),
          mainFile: { name: vf.name, path: fullPath, size: stats.size },
          extras: []
        });
      } catch (e) { /* skip */ }
    }
    // Also recurse into subdirectories
    results.push(...subdirs.flatMap(s => scanMediaUnits(path.join(dirPath, s.name), depth + 1)));
    return results;
  }

  // ── Case 1: folder has direct video files ──────────────────────────────────
  if (videoFiles.length > 0) {
    // Check if most files have SxxExx episode markers → treat as series with episodes in root
    const epFiles = videoFiles.filter(e => /S\d{1,2}E\d{1,3}/i.test(e.name));
    if (epFiles.length >= 3 && epFiles.length >= videoFiles.length * 0.5) {
      // Series with episodes directly in folder (no season subfolders)
      const episodes = [];
      const extras = [];
      for (const vf of videoFiles) {
        const fullPath = path.join(dirPath, vf.name);
        if (/S\d{1,2}E\d{1,3}/i.test(vf.name)) {
          episodes.push({
            number: extractEpisodeNumber(vf.name) || (episodes.length + 1),
            name: cleanEpisodeName(vf.name),
            fileName: vf.name,
            path: fullPath
          });
        } else {
          try {
            const stats = fs.statSync(fullPath);
            extras.push({ name: cleanExtraName(vf.name), fileName: vf.name, path: fullPath, size: stats.size });
          } catch (e) { /* skip */ }
        }
      }
      episodes.sort((a, b) => a.number - b.number);
      // Collect extras from supplement subfolders too
      for (const sd of subdirs.filter(s => isSupplementFolder(s.name))) {
        for (const v of collectVideos(path.join(dirPath, sd.name))) {
          extras.push({ name: cleanExtraName(v.name), fileName: v.name, path: v.path, size: v.size });
        }
      }
      const cleanName = cleanFolderName(folderName);
      if (cleanName.length < 2 || episodes.length === 0) {
        // Fallback to movie
        const unit = buildMediaUnit(dirPath, folderName);
        return unit ? [unit] : [];
      }
      return [{
        folderPath: dirPath, folderName, cleanName,
        year: extractYear(folderName),
        mainFile: { name: episodes[0].fileName, path: episodes[0].path, size: 0 },
        extras,
        seasons: [{ number: 1, name: 'Season 1', episodes }],
        isSeriesFolder: true,
        localEpisodeCount: episodes.length
      }];
    }
    const unit = buildMediaUnit(dirPath, folderName);
    return unit ? [unit] : [];
  }

  // ── Case 2: no direct videos ───────────────────────────────────────────────
  if (subdirs.length === 0) return [];

  // Watch-path roots (depth 0) are always organizational → just recurse
  if (depth === 0) {
    return subdirs.flatMap(s => scanMediaUnits(path.join(dirPath, s.name), depth + 1));
  }

  // Does this folder have season-like subfolders? → series!
  const seasonDirs = subdirs.filter(s => isSeasonLike(s.name));
  if (seasonDirs.length >= 1) {
    const unit = buildSeriesUnit(dirPath, folderName);
    return unit ? [unit] : [];
  }

  // Recurse into non-supplement subdirs
  const contentDirs = subdirs.filter(s => !isSupplementFolder(s.name));
  if (contentDirs.length === 0) return [];

  return contentDirs.flatMap(s => scanMediaUnits(path.join(dirPath, s.name), depth + 1));
}

// Clean folder name for TMDB search
function cleanFolderName(name) {
  let n = name;

  // 1. Cut everything after "+" or "AKA" (extras, bonus, alternate titles)
  n = n.replace(/\s*\+\s*.*/i, '');
  n = n.replace(/\s+AKA\s+.*/i, '');

  // 2. Normalize dots/underscores to spaces FIRST so subsequent regexes work on words
  n = n.replace(/[._]+/g, ' ');

  // 3. Remove season range markers: S01-S09, S01-09, and SxxExx episode markers
  n = n.replace(/\bS\d{2}-S\d{2}\b/gi, '');   // S01-S09
  n = n.replace(/\bS\d{2}-\d{2}\b/gi, '');    // S01-09
  n = n.replace(/\bS\d{1,2}(E\d{1,3})?\b/gi, '');

  // 4. Remove series-specific descriptors (including trailing number ranges: "Season 1-9")
  n = n.replace(/\b(serie\s*completa|complete\s*series|completo|completa)\b/gi, '');
  n = n.replace(/\b(temporada|season)s?\s*(\d+\s*(-\s*\d+)?)?\b/gi, '');  // "Season 1-9", "Season 1", "Temporada"
  n = n.replace(/\bserie\b/gi, '');

  // 5. Extract country codes (US), (UK), (ES) before stripping all parens
  n = n.replace(/\(([A-Z]{2})\)/g, ' $1 ');

  // 6. Remove ALL bracketed/parenthesized content
  n = n.replace(/[\[\(][^\]\)]*[\]\)]/g, '');

  // 7. Remove trailing release group (e.g. -SARTRE, -CKlicious, -dAV1nci)
  n = n.replace(/-[A-Za-z][A-Za-z0-9]+$/, '');

  // 8. Remove quality/codec/source tags
  n = n.replace(/\b(criterion|arrow|bfi|turbine\s*medien|uncut|remastered|rm4k|hybrid|sdr|hdr10?|ntsc|pal|theatrical|upscale|restored|repack|proper|fs|directors?\s*cut|extended\s*cut|extended|unrated|anniv|anniversary|reconstruction|eagle)\b/gi, '');
  n = n.replace(/\b(720p|1080p|2160p|4k|uhd|bluray|blu\s*ray|bdrip|brrip|dvdrip|dvd\s*rip|satrip|sat\s*rip|webrip|web\s*rip|web-dl|web\s*dl|webdl|hdtv|dvd|x264|x265|hevc|avc|xvid|divx|10bit|8bit|rip|remux|bdmv|bd)\b/gi, '');
  n = n.replace(/\b(aac|ac3|dts|dts-hd|dts-ma|dolby|atmos|flac|eac3|truehd|qaac|opus|av1|h264|h\s*264|pcm|ddp?\d*(\s*\d)?)\b/gi, '');
  // Language/audio/subtitle tags
  n = n.replace(/\b(latino|castellano|english|french|spanish|german|italian|japanese|multi\d*|dual|subs?|subtitles?|eng|spa|ita|fre|ger|jap|rus)\b/gi, '');
  // Streaming/distribution sources
  n = n.replace(/\b(hulu|amzn|amazon|netflix|nf|pcok|hbo|max|disney|atvp|mubi)\b/gi, '');
  // Common release descriptors that are never in titles
  n = n.replace(/\b(complete|commentary|rifftrax|collector'?s?\s*choice|volume\s*\d+)\b/gi, '');

  // 9. Remove year and everything after it
  const yearMatch = n.match(/\b((?:19|20)\d{2})\b/);
  if (yearMatch) {
    n = n.substring(0, n.indexOf(yearMatch[0]));
  }

  // 10. Remove orphaned number ranges left behind (e.g. "1-2", "1 9" from stripped "Season 1-9")
  n = n.replace(/\s{2,}\d{1,2}(\s*-\s*\d{1,2})?\s*$/, '');

  // 11. Clean up hyphens and extra spaces
  n = n.replace(/-+/g, ' ');
  n = n.replace(/\s+/g, ' ').trim();

  return n;
}

function cleanExtraName(fileName) {
  let n = fileName;
  n = n.replace(/\.[^.]+$/, ''); // remove extension
  n = n.replace(/[._\-]+/g, ' ');
  n = n.replace(/\s+/g, ' ').trim();
  return n;
}

function extractYear(str) {
  const match = str.match(/\b(19\d{2}|20[0-2]\d)\b/);
  return match ? match[0] : null;
}

// ────────────────────────────────────────────────
// TMDB API
// ────────────────────────────────────────────────
function tmdbRequest(apiKey, endpoint) {
  return new Promise((resolve, reject) => {
    const sep = endpoint.includes('?') ? '&' : '?';
    const url = `https://api.themoviedb.org/3${endpoint}${sep}api_key=${apiKey}`;
    const req = https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON parse error')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('TMDB timeout')); });
  });
}

// Normalize a string for fuzzy comparison
function normalizeForMatch(s) {
  return (s || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // remove accents
    .replace(/[^a-z0-9\s]/g, '')  // remove punctuation
    .replace(/\s+/g, ' ').trim();
}

// Score a TMDB result against our query + folder year
// Returns { titleScore (0-60), yearScore (-30 to +40), total }
function scoreResult(query, result, folderYear) {
  const q = normalizeForMatch(query);
  const title = normalizeForMatch(result.title || result.name || '');
  const origTitle = normalizeForMatch(result.original_title || result.original_name || '');

  // ── Title score (0-60) ──────────────────────────────────────────────────────
  let titleScore = 0;

  if (title === q || origTitle === q) {
    titleScore = 60; // exact match

  } else if (title.includes(q) || origTitle.includes(q)) {
    // query is a substring of the title (e.g. query "Psycho" in "Psycho II")
    titleScore = 30;

  } else if (q.includes(title) || q.includes(origTitle)) {
    // title is a substring of the query (query is more specific)
    const shorter = Math.min(q.length, Math.max(title.length, origTitle.length));
    const longer  = q.length;
    titleScore = Math.max(20, Math.round(40 * shorter / longer));

  } else {
    // Word overlap: count how many query words appear in the title
    const qWords = q.split(' ').filter(w => w.length > 1);
    const tWords = new Set([...title.split(' '), ...origTitle.split(' ')].filter(w => w.length > 1));
    if (qWords.length > 0) {
      const matched = qWords.filter(w => tWords.has(w));
      const overlap = matched.length / qWords.length;
      if (overlap >= 0.8) titleScore = 50;
      else if (overlap >= 0.6) titleScore = 35;
      else if (overlap >= 0.5) titleScore = 20;
      // below 50% → no title score (likely wrong movie)
    }
  }

  // ── Year score (-30 to +40) ─────────────────────────────────────────────────
  let yearScore = 0;
  if (folderYear) {
    const fy = parseInt(folderYear, 10);
    const releaseStr = result.release_date || result.first_air_date || '';
    const ry = parseInt(releaseStr.substring(0, 4), 10);
    if (!isNaN(ry)) {
      const diff = Math.abs(fy - ry);
      if (diff === 0)      yearScore = 40;
      else if (diff === 1) yearScore = 25;
      else if (diff === 2) yearScore = 10;
      else if (diff <= 5)  yearScore = -10;
      else                 yearScore = -30;
    }
  }

  // Exact title match: never let year penalty drag it below 0
  // (handles cases where folder year is wrong but title is unambiguous)
  if (titleScore >= 55 && yearScore < 0) yearScore = 0;

  return { titleScore, yearScore, total: titleScore + yearScore };
}

// Pick the best scoring result from TMDB search results
function pickBestResult(query, results, year) {
  if (!results || results.length === 0) return null;

  const scored = results
    .map(r => ({ result: r, score: scoreResult(query, r, year) }))
    .filter(s => s.score.titleScore > 0) // must have some title match
    .sort((a, b) => b.score.total - a.score.total);

  // Log top 3 candidates for debugging
  const top3 = scored.slice(0, 3);
  if (top3.length > 0) {
    top3.forEach(s => {
      const t = s.result.title || s.result.name;
      const ry = (s.result.release_date || s.result.first_air_date || '').substring(0, 4);
      console.log(`      [score ${s.score.total} title:${s.score.titleScore} year:${s.score.yearScore}] "${t}" (${ry}) [${s.result.mediaType}]`);
    });
  }

  if (scored.length > 0) return scored[0].result;

  // No title match: fallback for short/foreign queries (≤3 words) - trust TMDB ranking
  const qWords = normalizeForMatch(query).split(' ').filter(w => w.length > 1);
  if (qWords.length <= 3) {
    results.sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
    console.log(`      (fallback: query too short/foreign, using TMDB #1 by popularity)`);
    return results[0];
  }

  return null;
}

// Search TMDB for movie and/or TV. tvFirst=true for known series folders.
async function searchTMDB(apiKey, query, year = null, tvFirst = false) {
  try {
    const movieResults = [];
    const tvResults    = [];

    async function fetchMovie(withYear) {
      let ep = `/search/movie?query=${encodeURIComponent(query)}&language=en-US`;
      if (withYear && year) ep += `&year=${year}`;
      const r = await tmdbRequest(apiKey, ep);
      (r.results || []).forEach(x => {
        if (!movieResults.find(m => m.id === x.id)) movieResults.push({ ...x, mediaType: 'movie' });
      });
    }

    async function fetchTV(withYear) {
      let ep = `/search/tv?query=${encodeURIComponent(query)}&language=en-US`;
      if (withYear && year) ep += `&first_air_date_year=${year}`;
      const r = await tmdbRequest(apiKey, ep);
      (r.results || []).forEach(x => {
        if (!tvResults.find(t => t.id === x.id)) tvResults.push({ ...x, mediaType: 'tv' });
      });
    }

    await fetchMovie(true);
    if (year) await fetchMovie(false);
    await fetchTV(true);
    if (year) await fetchTV(false);

    // Build candidate list: TV first for series hints, movie first otherwise
    const allResults = tvFirst
      ? [...tvResults, ...movieResults]
      : [...movieResults, ...tvResults];

    const best = pickBestResult(query, allResults, year);
    if (best) {
      console.log(`    TMDB: "${query}" (${year||'?'}) -> "${best.title||best.name}" [${best.mediaType}] id:${best.id}`);
    } else {
      console.log(`    TMDB: "${query}" (${year||'?'}) -> no match (${allResults.length} results rejected)`);
    }
    return best;
  } catch (e) {
    console.warn('TMDB search error:', e.message);
    return null;
  }
}

async function getMovieDetails(apiKey, tmdbId) {
  try {
    return await tmdbRequest(apiKey, `/movie/${tmdbId}?language=en-US&append_to_response=credits,videos,keywords,release_dates`);
  } catch (e) { return null; }
}

async function getTVDetails(apiKey, tmdbId) {
  try {
    return await tmdbRequest(apiKey, `/tv/${tmdbId}?language=en-US&append_to_response=credits,videos,keywords,content_ratings`);
  } catch (e) { return null; }
}

// Fetch original language poster from TMDB
async function getOriginalPoster(apiKey, tmdbId, mediaType, originalLanguage) {
  try {
    const langs = [originalLanguage, 'null'].filter(Boolean).join(',');
    const data = await tmdbRequest(apiKey, `/${mediaType}/${tmdbId}/images?include_image_language=${langs}`);
    if (!data.posters || data.posters.length === 0) return null;
    // Prefer original language poster (often has original typography/art)
    const origLang = data.posters.filter(p => p.iso_639_1 === originalLanguage);
    if (origLang.length > 0) {
      // Pick highest rated original language poster
      origLang.sort((a, b) => b.vote_average - a.vote_average);
      return origLang[0].file_path;
    }
    // Fallback: poster without text (textless art)
    const noText = data.posters.filter(p => p.iso_639_1 === null);
    if (noText.length > 0) {
      noText.sort((a, b) => b.vote_average - a.vote_average);
      return noText[0].file_path;
    }
    return null;
  } catch (e) { return null; }
}

function buildEntry(mediaUnit, tmdbBasic, tmdbDetails) {
  const details = tmdbDetails || tmdbBasic || {};
  const credits = details.credits || {};
  const mediaType = tmdbBasic?.mediaType || 'movie';

  const directors = (credits.crew || [])
    .filter(p => p.job === 'Director')
    .map(p => ({ id: p.id, name: p.name, profile_path: p.profile_path || null }));

  // For TV: add created_by as directors
  if (mediaType === 'tv' && details.created_by) {
    details.created_by.forEach(p => {
      if (!directors.find(d => d.id === p.id)) {
        directors.push({ id: p.id, name: p.name, profile_path: p.profile_path || null });
      }
    });
  }

  const cast = (credits.cast || [])
    .slice(0, 15)
    .map(p => ({ id: p.id, name: p.name, character: p.character, profile_path: p.profile_path || null }));

  const writers = (credits.crew || [])
    .filter(p => ['Screenplay', 'Writer', 'Story', 'Novel'].includes(p.job))
    .slice(0, 5)
    .map(p => ({ id: p.id, name: p.name, job: p.job }));

  const trailer = (details.videos?.results || []).find(v => v.type === 'Trailer' && v.site === 'YouTube');

  // Certifications (content ratings)
  let certificationAR = null, certificationUS = null;
  if (mediaType === 'movie') {
    const releaseDates = details.release_dates?.results || [];
    const getCert = (country) => {
      const entry = releaseDates.find(r => r.iso_3166_1 === country);
      if (!entry) return null;
      const preferred = entry.release_dates.find(rd => rd.type === 3 && rd.certification);
      const fallback = entry.release_dates.find(rd => rd.certification);
      return preferred?.certification || fallback?.certification || null;
    };
    certificationAR = getCert('AR');
    certificationUS = getCert('US');
  } else {
    const contentRatings = details.content_ratings?.results || [];
    const getTVRating = (country) => contentRatings.find(r => r.iso_3166_1 === country)?.rating || null;
    certificationAR = getTVRating('AR');
    certificationUS = getTVRating('US');
  }

  // Handle TV vs Movie field differences
  const title = details.title || details.name || mediaUnit.cleanName;
  const originalTitle = details.original_title || details.original_name || '';
  const releaseDate = details.release_date || details.first_air_date || '';
  const year = releaseDate ? releaseDate.substring(0, 4) : (mediaUnit.year || '');
  const runtime = details.runtime || (details.episode_run_time && details.episode_run_time[0]) || null;

  return {
    id: `mu_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    folderPath: mediaUnit.folderPath,
    folderName: mediaUnit.folderName,
    mainFile: mediaUnit.mainFile,
    extras: mediaUnit.extras || [],
    mediaType: mediaType,
    tmdbId: details.id || null,
    imdbId: details.imdb_id || null,
    title: title,
    originalTitle: originalTitle,
    overview: details.overview || '',
    tagline: details.tagline || '',
    releaseDate: releaseDate,
    year: year,
    runtime: runtime,
    voteAverage: details.vote_average || null,
    voteCount: details.vote_count || 0,
    popularity: details.popularity || 0,
    posterPath: details.poster_path || tmdbBasic?.poster_path || null,
    backdropPath: details.backdrop_path || tmdbBasic?.backdrop_path || null,
    genres: (details.genres || []).map(g => g.name),
    directors: directors,
    cast: cast,
    writers: writers,
    productionCountries: (details.production_countries || details.origin_country || []).map(c => c.name || c),
    language: details.original_language || '',
    keywords: (details.keywords?.keywords || details.keywords?.results || []).slice(0, 10).map(k => k.name),
    trailerKey: trailer?.key || null,
    certificationAR: certificationAR,
    certificationUS: certificationUS,
    // TV specific
    numberOfSeasons: details.number_of_seasons || null,
    numberOfEpisodes: details.number_of_episodes || null,
    status: details.status || null,
    seasons: mediaUnit.seasons || null,
    // User data
    dateAdded: new Date().toISOString(),
    watched: false,
    watchedDate: null,
    rating: null,
    favorite: false,
    notes: ''
  };
}

// ────────────────────────────────────────────────
// ROUTES
// ────────────────────────────────────────────────

app.get('/api/config', (req, res) => {
  res.json(loadConfig());
});

app.post('/api/config', (req, res) => {
  try {
    const existing = loadConfig();
    const updated = { ...existing, ...req.body };
    saveConfig(updated);
    res.json({ ok: true, saved: updated });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/library', (req, res) => {
  res.json(loadLibrary());
});

// Scan for new media units
// force=true → wipe all entries from watch paths and return everything for re-identification
app.post('/api/scan', (req, res) => {
  const cfg = loadConfig();
  const dirs = cfg.watchPaths || [];
  const force = !!req.body.force;

  if (dirs.length === 0) {
    return res.json({ units: [], total: 0, new: 0, message: 'No hay rutas configuradas.' });
  }

  const allUnits = [];
  for (const dir of dirs) {
    const trimmed = dir.trim();
    if (fs.existsSync(trimmed)) {
      const found = scanMediaUnits(trimmed);
      console.log(`  ${trimmed}: ${found.length} media units`);
      allUnits.push(...found);
    } else {
      console.warn(`  No existe: ${trimmed}`);
    }
  }

  const existing = loadLibrary();

  if (force) {
    // Full rescan: remove entries from watch paths EXCEPT manually matched ones
    const manual = existing.filter(e =>
      e.manualMatch && dirs.some(d => e.folderPath && e.folderPath.startsWith(d.trim()))
    );
    const kept = existing.filter(e =>
      !dirs.some(d => e.folderPath && e.folderPath.startsWith(d.trim()))
    );
    // Re-add manual entries
    kept.push(...manual);
    saveLibrary(kept);
    // Don't re-scan manually matched folders
    const manualPaths = new Set(manual.map(e => e.folderPath));
    const toScan = allUnits.filter(u => !manualPaths.has(u.folderPath));
    console.log(`  Rescan completo: ${allUnits.length} unidades, ${manual.length} manuales preservadas, ${toScan.length} a re-identificar`);
    return res.json({ units: toScan, total: allUnits.length, new: toScan.length, forced: true, preserved: manual.length });
  }

  // Incremental scan
  // Detect series units that now subsume previously-scanned season subfolders
  // Remove old entries whose folderPath is a child of a detected series unit
  const seriesPaths = allUnits.filter(u => u.isSeriesFolder).map(u => u.folderPath);
  const withoutSubsumed = existing.filter(e =>
    !seriesPaths.some(sp => e.folderPath !== sp && e.folderPath.startsWith(sp + path.sep))
  );

  // Remove orphaned entries (folders no longer on disk)
  const valid = withoutSubsumed.filter(e => !e.folderPath || fs.existsSync(e.folderPath));
  if (valid.length < existing.length) {
    console.log(`  Limpiando ${existing.length - valid.length} entradas obsoletas`);
    saveLibrary(valid);
  }

  const validFolders = new Set(valid.map(e => e.folderPath));
  // Also include version folder paths
  valid.forEach(e => { if (e.versions) e.versions.forEach(v => { if (v.folderPath) validFolders.add(v.folderPath); }); });
  const newUnits = allUnits.filter(u => !validFolders.has(u.folderPath));
  console.log(`  Total: ${allUnits.length} | Nuevos: ${newUnits.length}`);
  res.json({ units: newUnits, total: allUnits.length, new: newUnits.length });
});

// Identify a media unit via TMDB
app.post('/api/identify', async (req, res) => {
  const cfg = loadConfig();
  if (!cfg.tmdbApiKey) return res.status(400).json({ error: 'Falta API key de TMDB' });
  const { mediaUnit, searchQuery, autoMode } = req.body;
  const query = searchQuery || mediaUnit.cleanName;
  // Series folders: search TV first for better accuracy
  const tvFirst = !searchQuery && !!mediaUnit.isSeriesFolder;
  const basic = await searchTMDB(cfg.tmdbApiKey, query, mediaUnit.year, tvFirst);

  // If no result found, return unidentified placeholder
  if (!basic) {
    if (autoMode) {
      // In auto scan mode, return an unidentified placeholder
      return res.json({ found: false, unidentified: true, mediaUnit });
    }
    return res.json({ found: false, mediaUnit });
  }

  // Calculate confidence from the scoring system
  const score = scoreResult(query, basic, mediaUnit.year);
  const confidence = score.total;

  // In auto mode with low confidence, mark as unidentified instead of guessing wrong
  if (autoMode && confidence < 50) {
    console.log(`    → Baja confianza (${confidence}) para "${query}" → "${basic.title || basic.name}" — marcado sin identificar`);
    return res.json({ found: false, unidentified: true, lowConfidence: true, mediaUnit,
      bestGuess: { title: basic.title || basic.name, year: (basic.release_date || basic.first_air_date || '').substring(0, 4), confidence } });
  }

  let details;
  if (basic.mediaType === 'tv') {
    details = await getTVDetails(cfg.tmdbApiKey, basic.id);
  } else {
    details = await getMovieDetails(cfg.tmdbApiKey, basic.id);
  }

  const entry = buildEntry(mediaUnit, basic, details);

  // Try to get original language poster
  const origLang = details?.original_language || basic?.original_language;
  if (origLang) {
    const origPoster = await getOriginalPoster(cfg.tmdbApiKey, basic.id, basic.mediaType, origLang);
    if (origPoster) entry.posterPath = origPoster;
  }

  // For TV series: compare local file count vs TMDB episode count
  let episodeWarning = null;
  if (basic.mediaType === 'tv' && mediaUnit.localEpisodeCount != null && details?.number_of_episodes) {
    const local = mediaUnit.localEpisodeCount;
    const tmdb  = details.number_of_episodes;
    const pct   = local / tmdb;
    if (pct < 0.5) {
      episodeWarning = `Solo ${local} archivos locales vs ${tmdb} episodios en TMDB (${Math.round(pct*100)}%)`;
      console.log(`    ⚠ ${entry.title}: ${episodeWarning}`);
    } else {
      console.log(`    ✓ ${entry.title}: ${local}/${tmdb} episodios (${Math.round(pct*100)}%)`);
    }
  }

  res.json({ found: true, entry, confidence, episodeWarning });
});

// Search TMDB manually (returns multiple results for user to choose)
app.post('/api/tmdb-search', async (req, res) => {
  const cfg = loadConfig();
  if (!cfg.tmdbApiKey) return res.status(400).json({ error: 'Falta API key de TMDB' });
  const { query, mediaType } = req.body; // mediaType: 'movie' | 'tv' | 'both'
  if (!query) return res.status(400).json({ error: 'Falta query' });

  try {
    const results = [];
    if (mediaType !== 'tv') {
      const mr = await tmdbRequest(cfg.tmdbApiKey, `/search/movie?query=${encodeURIComponent(query)}&language=en-US`);
      (mr.results || []).forEach(r => results.push({ ...r, mediaType: 'movie' }));
    }
    if (mediaType !== 'movie') {
      const tr = await tmdbRequest(cfg.tmdbApiKey, `/search/tv?query=${encodeURIComponent(query)}&language=en-US`);
      (tr.results || []).forEach(r => results.push({ ...r, mediaType: 'tv' }));
    }
    // Return top 10 sorted by popularity
    results.sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
    res.json({
      results: results.slice(0, 10).map(r => ({
        id: r.id,
        mediaType: r.mediaType,
        title: r.title || r.name || '',
        originalTitle: r.original_title || r.original_name || '',
        year: (r.release_date || r.first_air_date || '').substring(0, 4),
        posterPath: r.poster_path,
        overview: (r.overview || '').substring(0, 200),
        popularity: r.popularity
      }))
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Rematch: re-identify a library entry with a specific TMDB ID or new search
app.post('/api/rematch', async (req, res) => {
  const cfg = loadConfig();
  if (!cfg.tmdbApiKey) return res.status(400).json({ error: 'Falta API key de TMDB' });
  const { entryId, tmdbId, mediaType } = req.body;
  if (!entryId || !tmdbId || !mediaType) return res.status(400).json({ error: 'Faltan parámetros' });

  const lib = loadLibrary();
  const idx = lib.findIndex(e => e.id === entryId);
  if (idx < 0) return res.status(404).json({ error: 'Entrada no encontrada' });

  const existing = lib[idx];

  try {
    let details;
    if (mediaType === 'tv') {
      details = await getTVDetails(cfg.tmdbApiKey, tmdbId);
    } else {
      details = await getMovieDetails(cfg.tmdbApiKey, tmdbId);
    }
    if (!details) return res.status(404).json({ error: 'No se encontró en TMDB' });

    // Build a minimal mediaUnit from existing entry to pass to buildEntry
    const mediaUnit = {
      folderPath: existing.folderPath,
      folderName: existing.folderName,
      mainFile: existing.mainFile,
      extras: existing.extras || [],
      seasons: existing.seasons || null,
      cleanName: cleanFolderName(existing.folderName || ''),
      year: extractYear(existing.folderName || ''),
    };

    const basic = { ...details, mediaType };
    const entry = buildEntry(mediaUnit, basic, details);

    // Preserve user data
    entry.id = existing.id;
    entry.watched = existing.watched;
    entry.watchedDate = existing.watchedDate;
    entry.rating = existing.rating;
    entry.favorite = existing.favorite;
    entry.notes = existing.notes;
    entry.dateAdded = existing.dateAdded;
    entry.versions = existing.versions || null;
    entry.manualMatch = true; // Protect from rescan overwrite

    // Original language poster
    const origLang = details.original_language;
    if (origLang) {
      const origPoster = await getOriginalPoster(cfg.tmdbApiKey, tmdbId, mediaType, origLang);
      if (origPoster) entry.posterPath = origPoster;
    }

    // Check if another entry already exists with the same tmdbId (different folder = duplicate version)
    const dupIdx = lib.findIndex((e, i) => i !== idx && e.mediaType === mediaType && e.tmdbId === tmdbId);

    if (dupIdx >= 0) {
      // Merge: absorb this entry's folder as a version of the existing duplicate
      const primary = lib[dupIdx];

      // Build versions list from both entries' folders
      const allVersions = [
        ...(primary.versions || [{ folderPath: primary.folderPath, folderName: primary.folderName, mainFile: primary.mainFile, extras: primary.extras || [] }]),
        ...(existing.versions || [{ folderPath: existing.folderPath, folderName: existing.folderName, mainFile: existing.mainFile, extras: existing.extras || [] }])
      ];
      // Deduplicate versions by folderPath
      const seenPaths = new Set();
      primary.versions = allVersions.filter(v => {
        if (seenPaths.has(v.folderPath)) return false;
        seenPaths.add(v.folderPath);
        return true;
      });
      // Merge extras
      const allExtras = [...(primary.extras || [])];
      for (const v of existing.versions || [{ extras: existing.extras || [] }]) {
        if (v.extras) allExtras.push(...v.extras);
      }
      primary.extras = allExtras;
      // Preserve "best" user data (watched/favorite from either)
      if (existing.watched) { primary.watched = true; primary.watchedDate = primary.watchedDate || existing.watchedDate; }
      if (existing.favorite) primary.favorite = true;

      // Remove the corrected entry (it's now absorbed into primary)
      lib.splice(idx, 1);
      saveLibrary(lib);
      console.log(`  Rematch+merge: "${existing.title}" → merged into "${primary.title}" (${primary.versions.length} versiones)`);
      res.json({ ok: true, entry: primary, merged: true });
    } else {
      lib[idx] = entry;
      saveLibrary(lib);
      console.log(`  Rematch: "${existing.title}" → "${entry.title}" (${entry.year}) [${mediaType}]`);
      res.json({ ok: true, entry });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/library/add', (req, res) => {
  try {
    const lib = loadLibrary();
    const entry = req.body;
    const idx = lib.findIndex(e => e.folderPath === entry.folderPath);
    if (idx >= 0) lib[idx] = { ...lib[idx], ...entry, extras: entry.extras };
    else lib.push(entry);
    saveLibrary(lib);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/library/bulk', (req, res) => {
  try {
    const { entries } = req.body;
    const lib = loadLibrary();

    // Add new entries by folderPath
    const pathMap = new Map(lib.map(e => [e.folderPath, e]));
    for (const entry of entries) pathMap.set(entry.folderPath, entry);
    let all = Array.from(pathMap.values());

    // Deduplicate by tmdbId: merge different versions of the same movie
    const tmdbGroups = new Map();
    const noTmdb = [];
    for (const entry of all) {
      if (!entry.tmdbId) { noTmdb.push(entry); continue; }
      const key = `${entry.mediaType}_${entry.tmdbId}`;
      if (!tmdbGroups.has(key)) tmdbGroups.set(key, []);
      tmdbGroups.get(key).push(entry);
    }

    const deduped = [...noTmdb];
    for (const [, group] of tmdbGroups) {
      if (group.length === 1) { deduped.push(group[0]); continue; }
      // Merge: keep the first entry's metadata, collect all versions
      const primary = group[0];
      const versions = group.map(e => ({
        folderPath: e.folderPath,
        folderName: e.folderName,
        mainFile: e.mainFile,
        extras: e.extras || []
      }));
      primary.versions = versions;
      // Merge all extras from all versions
      const allExtras = [];
      for (const v of group) {
        if (v.extras) allExtras.push(...v.extras);
      }
      primary.extras = allExtras;
      // Keep user data (watched/favorite) if any version had it
      if (group.some(e => e.watched)) { primary.watched = true; primary.watchedDate = primary.watchedDate || new Date().toISOString(); }
      if (group.some(e => e.favorite)) primary.favorite = true;
      deduped.push(primary);
    }

    saveLibrary(deduped);
    res.json({ ok: true, count: deduped.length, merged: all.length - deduped.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/library/:id', (req, res) => {
  try {
    const lib = loadLibrary();
    const idx = lib.findIndex(e => e.id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: 'Not found' });
    lib[idx] = { ...lib[idx], ...req.body };
    saveLibrary(lib);
    res.json(lib[idx]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/library/:id', (req, res) => {
  try {
    const lib = loadLibrary().filter(e => e.id !== req.params.id);
    saveLibrary(lib);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Play a file with MPC-HC
app.post('/api/play', (req, res) => {
  const cfg = loadConfig();
  const { filePath } = req.body;
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Archivo no encontrado: ' + filePath });
  }
  const mpcPath = cfg.mpcPath || 'C:\\Program Files\\MPC-HC\\mpc-hc64.exe';
  const cmd = `"${mpcPath}" "${filePath}"`;
  exec(cmd, (err) => {
    if (err) {
      const alt = `"C:\\Program Files (x86)\\MPC-HC\\mpc-hc.exe" "${filePath}"`;
      exec(alt, (err2) => {
        if (err2) return res.status(500).json({ error: 'No se pudo abrir MPC-HC.' });
        res.json({ ok: true });
      });
    } else {
      res.json({ ok: true });
    }
  });
});

// Image proxies
app.get('/api/poster', (req, res) => {
  const { path: p, size } = req.query;
  if (!p) return res.status(400).end();
  const url = `https://image.tmdb.org/t/p/${size || 'w300'}${p}`;
  https.get(url, img => {
    res.setHeader('Content-Type', img.headers['content-type'] || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    img.pipe(res);
  }).on('error', () => res.status(500).end());
});

app.get('/api/backdrop', (req, res) => {
  const { path: p } = req.query;
  if (!p) return res.status(400).end();
  const url = `https://image.tmdb.org/t/p/w1280${p}`;
  https.get(url, img => {
    res.setHeader('Content-Type', img.headers['content-type'] || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    img.pipe(res);
  }).on('error', () => res.status(500).end());
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/public/index.html'));
});

app.listen(PORT, () => {
  console.log(`\n  CINEMATECA corriendo en http://localhost:${PORT}\n`);
  const cfg = loadConfig();
  if (cfg.watchPaths && cfg.watchPaths.length > 0) {
    console.log('  Rutas:', cfg.watchPaths.join(', '));
  }
  console.log('');
});
