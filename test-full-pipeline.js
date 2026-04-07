#!/usr/bin/env node
'use strict';
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

console.log('Creating test video and processing...\n');

const testDir = '/tmp/katy-test';
const inputVideo = path.join(testDir, 'test-input.mp4');
const outputVideo = path.join(testDir, 'test-output.mp4');

async function run() {
  try {
    if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });

    console.log('1️⃣ Creating test video (5 seconds)...');
    const createCmd = `ffmpeg -f lavfi -i color=c=blue:s=1920x1080:d=5 -f lavfi -i sine=f=1000:d=5 -pix_fmt yuv420p -y "${inputVideo}" 2>&1`;
    await execAsync(createCmd);
    console.log('   ✅ Test video created\n');

    console.log('2️⃣ Adding text overlay...');
    const fontBold = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
    const fontNormal = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';

    const overlayCmd = `ffmpeg -i "${inputVideo}" -vf "format=yuv420p,drawbox=x=0:y=ih-150:w=iw:h=150:color=0x000000BB:t=fill,drawbox=x=0:y=ih-150:w=iw:h=4:color=0xDC2626FF:t=fill,drawtext=fontfile=${fontBold}:text='KATY TRUCK SALES':fontsize=20:fontcolor=0xFFFFFF88:x=20:y=h-142,drawtext=fontfile=${fontBold}:text='2020 PETERBILT 389':fontsize=42:fontcolor=white:x=20:y=h-115,drawtext=fontfile=${fontBold}:text='\\$45,500 OBO':fontsize=38:fontcolor=0xEF4444FF:x=20:y=h-68,drawtext=fontfile=${fontNormal}:text='125K MILES | (281) 891-0597':fontsize=22:fontcolor=0xFFFFFFAA:x=20:y=h-30" -c:v libx264 -preset fast -crf 20 -c:a aac -b:a 128k -movflags +faststart -y "${outputVideo}" 2>&1`;

    await execAsync(overlayCmd);
    console.log('   ✅ Overlay added\n');

    console.log('3️⃣ Verifying output...');
    const stats = fs.statSync(outputVideo);
    const sizeInMB = (stats.size / 1024 / 1024).toFixed(2);
    console.log(`   File size: ${sizeInMB} MB\n`);

    console.log('4️⃣ Moving to processed directory...');
    const processedDir = '/var/www/sites/katy-truck-social/app/processed';
    if (!fs.existsSync(processedDir)) fs.mkdirSync(processedDir, { recursive: true });

    const finalPath = path.join(processedDir, 'test-sample.mp4');
    fs.copyFileSync(outputVideo, finalPath);
    console.log(`   ✅ Saved\n`);

    console.log('5️⃣ Testing caption generation...');
    const Anthropic = require('@anthropic-ai/sdk');
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_KEY });

    const response = await anthropic.messages.create({
      model: 'claude-opus-4-1',
      max_tokens: 900,
      messages: [{
        role: 'user',
        content: `Write 3 social media captions for this truck. Return ONLY JSON with facebook, instagram, tiktok keys.

Truck: 2020 Peterbilt 389
Price: $45,500
Mileage: 125,000 miles
Phone: (281) 891-0597`
      }]
    });

    const text = response.content[0].text.trim()
      .replace(/^```json\s*/i, '').replace(/\s*```$/, '');
    const captions = JSON.parse(text);

    console.log('   ✅ Captions generated\n');

    console.log('═══════════════════════════════════════════');
    console.log('FULL PIPELINE TEST SUCCESSFUL\n');
    console.log('Download video:');
    console.log('https://stricklandtechnology.net/trucks/processed/test-sample.mp4\n');
    console.log('Facebook: ' + captions.facebook.substring(0, 80) + '...\n');
    console.log('Instagram: ' + captions.instagram.substring(0, 80) + '...\n');
    console.log('TikTok: ' + captions.tiktok.substring(0, 80) + '...\n');
    console.log('═══════════════════════════════════════════');

  } catch (error) {
    console.error('ERROR:', error.message);
    process.exit(1);
  }
}

run();
