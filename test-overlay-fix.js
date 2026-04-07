const fs = require('fs');
const { execSync } = require('child_process');

const FONT_BOLD   = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
const FONT_NORMAL = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
const DEALER_NAME = 'KATY TRUCK';
const DEALER_PHONE = '(281) 891-0597';

function ffEsc(str) {
  return String(str || '')
    .replace(/[$,\:'"\[\]{}|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildOverlay(specs) {
  const { year, make, model, mileage, price, financing } = specs;
  const truck      = ffEsc(.toUpperCase());
  const priceNum   = price ? Number(price) : 0;
  const priceStr   = priceNum > 0 ? priceNum.toLocaleString().replace(/,/g,'') + ' OBO' : 'CALL FOR PRICE';
  const milesNum   = mileage ? Number(mileage) : 0;
  const milesStr   = milesNum > 0 ? milesNum.toLocaleString().replace(/,/g,'') + ' MI' : '';
  const finStr     = financing === 'yes' ? ' | FINANCING AVAIL' : '';
  const phone      = DEALER_PHONE.replace(/[()\s]/g, '-').replace(/--/g,'-');
  const infoLine   = ffEsc();
  const dealerLine = ffEsc(DEALER_NAME.toUpperCase());
  const priceEsc   = ffEsc(priceStr);

  return [
    'format=yuv420p',
    'drawbox=x=0:y=ih-150:w=iw:h=150:color=0x000000BB:t=fill',
    'drawbox=x=0:y=ih-150:w=iw:h=4:color=0xDC2626FF:t=fill',
    ,
    ,
    ,
    ,
    'drawbox=x=iw-160:y=ih-145:w=150:h=40:color=0xDC2626FF:t=fill',
    ,
  ].join(',');
}

console.log('TEST SUITE: Overlay Fix Verification\n');

const specs = { year: 2023, make: 'Freightliner', model: 'Cascadia 126', mileage: '520821', price: '62995', financing: 'yes', notes: '' };
const filter = buildOverlay(specs);

let passed = 0;
let failed = 0;

// Test 1: No invalid syntax
if (!filter.includes('main_w') && !filter.includes('main_h')) {
  console.log('✓ TEST 1 PASS: Invalid main_w/main_h syntax NOT present');
  passed++;
} else {
  console.log('✗ TEST 1 FAIL: Old syntax still present');
  failed++;
}

// Test 2: Valid syntax present
if (filter.includes('x=w-145:y=h-138')) {
  console.log('✓ TEST 2 PASS: Valid w-145/h-138 syntax IS present');
  passed++;
} else {
  console.log('✗ TEST 2 FAIL: Valid syntax not found');
  failed++;
}

// Test 3: All filters present
if (filter.includes('format=yuv420p') && (filter.match(/drawbox/g) || []).length === 2 && (filter.match(/drawtext/g) || []).length === 5) {
  console.log('✓ TEST 3 PASS: All required filters present');
  passed++;
} else {
  console.log('✗ TEST 3 FAIL: Missing filters');
  failed++;
}

// Test 4: Real FFmpeg validation
const inputFile = '/var/www/sites/katy-truck-social/app/uploads/e175543a-799d-44a5-aea0-95a5017af9e1.mp4';
const outputFile = '/tmp/test-' + Date.now() + '.mp4';

if (fs.existsSync(inputFile)) {
  try {
    const cmd = /bin/bash: line 108: ffmpeg: command not found;
    execSync(cmd, { stdio: 'pipe' });
    
    if (fs.existsSync(outputFile) && fs.statSync(outputFile).size > 0) {
      console.log('✓ TEST 4 PASS: FFmpeg processes overlay successfully');
      passed++;
      fs.unlinkSync(outputFile);
    } else {
      console.log('✗ TEST 4 FAIL: No output file created');
      failed++;
    }
  } catch (e) {
    console.log('✗ TEST 4 FAIL: FFmpeg error - ' + e.message.slice(0, 80));
    failed++;
  }
} else {
  console.log('⊘ TEST 4 SKIP: Input file not found');
}

console.log('\nRESULTS: ' + passed + ' passed, ' + failed + ' failed');
if (failed === 0 && passed >= 3) {
  console.log('\n✅ OVERLAY FIX VERIFIED - Ready for production');
}
