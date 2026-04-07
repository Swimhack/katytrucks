#!/usr/bin/env node
'use strict';
require('dotenv').config();

const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');

console.log('🧪 Katy Trucks Video Overlay Caption Prototype Test\n');

// Test 1: Verify Anthropic API
console.log('1️⃣ Testing Anthropic API...');
const apiKey = process.env.ANTHROPIC_KEY;
if (!apiKey) {
  console.log('❌ ANTHROPIC_KEY not found in .env');
  process.exit(1);
}

const anthropic = new Anthropic({ apiKey });

// Test 2: Generate sample captions
(async () => {
  try {
    console.log('   Generating captions for sample truck...\n');
    
    const response = await anthropic.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 900,
      messages: [{
        role: 'user',
        content: 
      }]
    });

    const text = response.content[0].text.trim()
      .replace(/^$/, '');
    const captions = JSON.parse(text);

    console.log('✅ Captions Generated Successfully:\n');
    console.log('📘 Facebook:');
    console.log(captions.facebook + '\n');
    console.log('📸 Instagram:');
    console.log(captions.instagram + '\n');
    console.log('🎵 TikTok:');
    console.log(captions.tiktok + '\n');

    // Test 3: Verify FFmpeg
    console.log('2️⃣ Checking FFmpeg availability...');
    const { execSync } = require('child_process');
    try {
      const version = execSync('ffmpeg -version 2>&1').toString().split('\n')[0];
      console.log();
    } catch (e) {
      console.log('   ❌ FFmpeg not found');
    }

    // Test 4: Show video overlay concept
    console.log('3️⃣ Video Overlay FFmpeg Command:');
    console.log();

    console.log('✅ Prototype Test Complete!');
    console.log('\nNext steps:');
    console.log('1. Upload a valid MP4 file via the web form at https://stricklandtechnology.net/trucks');
    console.log('2. System will add overlay with truck specs');
    console.log('3. Claude generates platform-specific captions');
    console.log('4. Results emailed to Eric + James');

  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
})();
