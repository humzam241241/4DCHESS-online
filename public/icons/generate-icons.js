// Run: node public/icons/generate-icons.js
// Generates PNG icons from canvas for PWA
const fs = require('fs');
const path = require('path');

function createSVG(size, maskable = false) {
  const padding = maskable ? size * 0.1 : 0;
  const inner = size - padding * 2;
  const cx = size / 2;
  const cy = size / 2;
  const fontSize = inner * 0.45;
  const subSize = inner * 0.12;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" fill="#0f0f1a" rx="${maskable ? 0 : size * 0.15}"/>
  <circle cx="${cx}" cy="${cy}" r="${inner * 0.38}" fill="none" stroke="#7c3aed" stroke-width="${size * 0.02}" opacity="0.3"/>
  <text x="${cx}" y="${cy + fontSize * 0.35}" font-family="serif" font-size="${fontSize}" fill="#e0d6ff" text-anchor="middle">\u265A</text>
  <circle cx="${cx - inner * 0.25}" cy="${cy - inner * 0.25}" r="${subSize}" fill="#ef4444"/>
  <circle cx="${cx + inner * 0.25}" cy="${cy - inner * 0.25}" r="${subSize}" fill="#eab308"/>
  <circle cx="${cx + inner * 0.25}" cy="${cy + inner * 0.25}" r="${subSize}" fill="#22c55e"/>
  <circle cx="${cx - inner * 0.25}" cy="${cy + inner * 0.25}" r="${subSize}" fill="#64748b"/>
</svg>`;
}

// Write SVG files (can be used directly as icons)
const dir = path.join(__dirname);
fs.writeFileSync(path.join(dir, 'icon-192.svg'), createSVG(192));
fs.writeFileSync(path.join(dir, 'icon-512.svg'), createSVG(512));
fs.writeFileSync(path.join(dir, 'icon-maskable-512.svg'), createSVG(512, true));

console.log('SVG icons generated. Convert to PNG with:');
console.log('  npx svgexport icon-192.svg icon-192.png 192:192');
console.log('  npx svgexport icon-512.svg icon-512.png 512:512');
console.log('Or use any SVG-to-PNG converter.');

// Also create a simple favicon SVG
const favicon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" fill="#0f0f1a" rx="4"/>
  <text x="16" y="24" font-family="serif" font-size="20" fill="#e0d6ff" text-anchor="middle">\u265A</text>
</svg>`;
fs.writeFileSync(path.join(dir, 'favicon.svg'), favicon);
console.log('Favicon SVG generated.');
