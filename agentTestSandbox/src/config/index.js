const dotenv = require('dotenv');
const path = require('path');
const defaultConfig = require('./default.json');

dotenv.config();

const config = {
  server: {
    port: parseInt(process.env.PORT, 10) || defaultConfig.server.port,
    host: process.env.HOST || defaultConfig.server.host
  },
  database: {
    url: process.env.DATABASE_URL || defaultConfig.database.url,
    name: process.env.DATABASE_NAME || defaultConfig.database.name
  },
  logging: {
    level: process.env.LOG_LEVEL || defaultConfig.logging.level,
    format: process.env.LOG_FORMAT || defaultConfig.logging.format
  },
  security: {
    jwtSecret: process.env.JWT_SECRET || defaultConfig.security.jwtSecret,
    jwtExpiresIn: process.env.JWT_EXPIRES_IN || defaultConfig.security.jwtExpiresIn
  }
};

module.exports = config;