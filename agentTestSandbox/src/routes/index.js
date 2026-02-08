const express = require('express');
const router = express.Router();
const healthCheckRouter = require('./healthCheck');

router.use('/health', healthCheckRouter);

module.exports = router;