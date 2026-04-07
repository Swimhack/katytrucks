#!/usr/bin/env node
'use strict';
require('dotenv').config();

const Anthropic = require('@anthropic-ai/sdk');

console.log('Testing Katy Trucks Video Overlay Caption System\n');

const apiKey = process.env.ANTHROPIC_KEY;
if (!apiKey) {
  console.log('ERROR: ANTHROPIC_KEY not found in .env');
  process.exit(1);
}

const anthropic = new Anthropic({ apiKey });

(async () => {
  try {
    console.log('Generating captions for sample truck...\n');

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

    console.log('SUCCESS - Captions Generated:\n');
    console.log('Facebook:');
    console.log(captions.facebook + '\n');
    console.log('Instagram:');
    console.log(captions.instagram + '\n');
    console.log('TikTok:');
    console.log(captions.tiktok + '\n');

    console.log('System is working! Upload a valid MP4 video to start.');

  } catch (error) {
    console.error('ERROR:', error.message);
    process.exit(1);
  }
})();
