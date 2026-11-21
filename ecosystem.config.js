// ecosystem.config.js
module.exports = {
  apps: [
    {
      name: "pos-dealer-api",
      script: "server.js",
      kill_timeout: 12000, // SIGINT এর পর 12s পর্যন্ত wait করবে, তারপর SIGKILL
    },
  ],
};
