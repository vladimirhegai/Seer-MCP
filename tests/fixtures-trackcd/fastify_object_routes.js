// Fastify object-style route registrations — regression fixture for the
// `app.route({ method, url, handler })` shape that was claimed-but-not-
// implemented before bug 6 was fixed.
const fastify = require('fastify');
const app = fastify();

function getThing(req, reply) { return { ok: true }; }
function upsertThing(req, reply) { return { upserted: true }; }
function deleteThing(req, reply) { return { deleted: true }; }

// Single-method object form
app.route({
  method: 'GET',
  url: '/things/:id',
  handler: getThing,
});

// Multi-method object form (array of methods → one route each)
app.route({
  method: ['PUT', 'PATCH'],
  url: '/things/:id',
  handler: upsertThing,
});

// Order of fields shouldn't matter — handler first, url last.
app.route({
  handler: deleteThing,
  method: 'DELETE',
  url: '/things/:id',
});

module.exports = app;
