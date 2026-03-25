const express = require('express');
const cors = require('cors');
const { pool, testDbConnection } = require('./db');

const spatialRoutes = require('./routes/spatialRoutes');
const analysisRoutes = require('./routes/analysisRoutes');

const app = express();
app.use(cors());
app.use(express.json());

spatialRoutes(app, pool);
analysisRoutes(app, pool);

const port = process.env.PORT || 3000;
testDbConnection().then(() => {
  app.listen(port, () => {
    console.log('Backend listening on', port);
  });
});
