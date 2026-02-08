const express = require('express');
const router = express.Router();

// Home route
router.get('/', (req, res) => {
    res.json({ message: 'Welcome to the API' });
});

// Health check endpoint
router.get('/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

module.exports = router;