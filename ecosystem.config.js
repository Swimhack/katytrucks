module.exports = {
  apps: [{
    name: 'truck-autopilot',
    script: 'server.js',
    cwd: '/var/www/sites/katy-truck-social/app',
    instances: 1,
    env: {
      PORT: 3155,
      NODE_ENV: 'production',
      BASE_URL: 'https://stricklandtechnology.net/trucks',
      ANTHROPIC_KEY: process.env.ANTHROPIC_KEY,
      AYRSHARE_KEY: process.env.AYRSHARE_KEY || '',
      ERIC_EMAIL: 'Eric@katytruckandequipmentsales.com',
      SMTP_PASS: process.env.SMTP_PASS
    }
  }]
};
