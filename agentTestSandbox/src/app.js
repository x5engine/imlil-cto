const express = require('express');
const requestLogger = require('./middleware/requestLogger');
const logger = require('./utils/logger');

const app = express();

// Apply request logging middleware
app.use(requestLogger);

// Error handling middleware
app.use((err, req, res, next) => {
  logger.error({
    message: err.message,
    stack: err.stack,
    path: req.path
  });
  res.status(500).json({ error: 'Internal Server Error' });
});

module.exports = app;