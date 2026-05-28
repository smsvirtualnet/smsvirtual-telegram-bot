module.exports = {
  apps: [
    {
      name: "smsvirtual-telegram-bot",
      script: "src/index.js",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_restarts: 10,
      min_uptime: "30s",
      restart_delay: 4000,
      max_memory_restart: "256M",
      kill_timeout: 5000,
      env: {
        NODE_ENV: "production",
      },
      out_file: "./data/pm2.out.log",
      error_file: "./data/pm2.err.log",
      merge_logs: true,
      time: true,
    },
  ],
};
