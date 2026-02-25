// Script: agrega certificationAR y certificationUS desde IMDb parentalguide
// Re-escribe TODAS las entradas que tengan imdbId (sobreescribe datos previos de TMDB)
// Uso: node scripts/add-certifications.js

const fs = require('fs');
const https = require('https');

const LIBRARY_PATH = 'c:/Users/Julian/Documents/cinemateca/data/library.json';

// ─── helpers ────────────────────────────────────────────────────────────────

function fetchIMDb(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url.startsWith('/') ? 'https://www.imdb.com' + url : url);
    https.get(parsed, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchIMDb(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

function extractCerts(html) {
  // Extract certificates from __NEXT_DATA__ JSON
  const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) return { ar: null, us: null };

  try {
    const data = JSON.parse(match[1]);
    const str = JSON.stringify(data);

    // Find the pre-processed certificates array (cleaner format)
    // Format: "certificates":[{"country":"Argentina","ratings":[{"rating":"16",...}]},...]
    const certsMatch = str.match(/"certificates":\[(\{"country":.+?)\],"fetchedCertificates"/);
    if (certsMatch) {
      const certs = JSON.parse('[' + certsMatch[1] + ']');
      const ar = certs.find(c => c.country === 'Argentina');
      const us = certs.find(c => c.country === 'United States');
      return {
        ar: ar?.ratings?.[0]?.rating || null,
        us: us?.ratings?.[0]?.rating || null
      };
    }

    // Fallback: parse from the edges format
    // Format: "certificates":{"total":N,"edges":[{"node":{"rating":"16","country":{"id":"AR",...}}}]}
    const edgesMatch = str.match(/"certificates":\{"total":\d+,"edges":\[(.*?)\],"__typename/);
    if (edgesMatch) {
      const edges = JSON.parse('[' + edgesMatch[1] + ']');
      const arNode = edges.find(e => e.node?.country?.id === 'AR');
      const usNode = edges.find(e => e.node?.country?.id === 'US');
      return {
        ar: arNode?.node?.rating || null,
        us: usNode?.node?.rating || null
      };
    }
  } catch (e) {
    // JSON parse error, return nulls
  }

  return { ar: null, us: null };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  const library = JSON.parse(fs.readFileSync(LIBRARY_PATH, 'utf8'));
  const pending = library.filter(m => m.imdbId);

  console.log(`Total en librería: ${library.length}`);
  console.log(`Con imdbId (a procesar): ${pending.length}`);

  let updated = 0, failed = 0, withAR = 0, withUS = 0;

  for (let i = 0; i < pending.length; i++) {
    const m = pending[i];
    process.stdout.write(`[${i + 1}/${pending.length}] ${m.title} (${m.year || '?'})... `);

    try {
      const html = await fetchIMDb(`https://www.imdb.com/title/${m.imdbId}/parentalguide/`);
      const certs = extractCerts(html);

      const entry = library.find(x => x.id === m.id);
      entry.certificationAR = certs.ar;
      entry.certificationUS = certs.us;

      if (certs.ar) withAR++;
      if (certs.us) withUS++;
      console.log(`AR=${certs.ar || '-'}  US=${certs.us || '-'}`);
      updated++;
    } catch (e) {
      console.log(`ERROR: ${e.message}`);
      failed++;
    }

    // Save every 50 entries
    if ((i + 1) % 50 === 0) {
      fs.writeFileSync(LIBRARY_PATH, JSON.stringify(library, null, 2), 'utf8');
      console.log('  [guardado parcial]');
    }

    // IMDb rate limit: ~500ms between requests to avoid blocks
    await sleep(500);
  }

  // Final save
  fs.writeFileSync(LIBRARY_PATH, JSON.stringify(library, null, 2), 'utf8');
  console.log(`\nListo.`);
  console.log(`  Actualizadas: ${updated}  Fallidas: ${failed}`);
  console.log(`  Con AR: ${withAR}  Con US: ${withUS}`);
}

main().catch(e => { console.error(e); process.exit(1); });
