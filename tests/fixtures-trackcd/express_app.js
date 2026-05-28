// Express-style route registrations for the route extractor test.
const express = require('express');
const app = express();

function listUsers(req, res) {
  const dbUrl = process.env.DATABASE_URL;
  const timeoutMs = process.env["TIMEOUT_MS"];
  if (req.query.active) {
    return res.json({ active: true });
  } else if (req.query.archived) {
    return res.json({ archived: true });
  } else {
    return res.json({ all: true });
  }
}

function createUser(req, res) {
  return res.status(201).json({ created: true });
}

function deleteUser(req, res) {
  return res.status(204).end();
}

app.get('/users', listUsers);
app.post('/users', createUser);
app.delete('/users/:id', deleteUser);
app.put('/users/:id', (req, res) => res.json({}));

module.exports = app;
