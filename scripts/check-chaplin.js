const fs = require('fs');
const lib = JSON.parse(fs.readFileSync('c:/Users/Julian/Documents/cinemateca/data/library.json', 'utf8'));
const chaplin = lib.filter(m => (m.folderPath||'').toLowerCase().includes('chaplin'));
console.log('Entradas Chaplin actuales:', chaplin.length);
console.log('Total librería:', lib.length);
chaplin.forEach(m => {
  const parts = (m.folderPath||'').split('\\');
  const folder = parts[parts.length-1];
  console.log(' -', m.title, '(' + m.year + ') | manual:', !!m.manualMatch, '|', folder.substring(0,60));
});

// Also check if the bulk add endpoint might be causing the issue - look for duplicate folderPaths
console.log('\nFolderPaths duplicados:');
const fpCount = {};
lib.forEach(m => { fpCount[m.folderPath] = (fpCount[m.folderPath]||0)+1; });
Object.entries(fpCount).filter(([k,v])=>v>1).forEach(([k,v])=> console.log('  x'+v, k.substring(k.length-60)));
