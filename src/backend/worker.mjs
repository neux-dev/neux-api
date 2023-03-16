import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import nconf from 'nconf';
import express from 'express';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import session from 'express-session';
import compression from 'compression';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import passport from 'passport';
import db from './db/index.mjs';
import logger from './lib/logger.mjs';
import lifecycle from './events/lifecycle.mjs';
import setupRoutes from './routes/index.mjs';

const PUBLIC_DIR = path.join(path.dirname(__filename), 'public');
let server, httpServer;

// Shutdown worker
async function shutdown () {
  if (shutdown.executed) return;
  shutdown.executed = true;
  const timeout = parseInt(nconf.get('timeout'));
  if (timeout > 0) {
    setTimeout(() => process.exit(1), timeout * 1000);
  }
  try {
    lifecycle.emit('shutdown');
    await db?.disconnect();
    await Promise.all([
      new Promise(resolve => server ? server.close(resolve) : resolve()),
      new Promise(resolve => httpServer ? httpServer.close(resolve) : resolve())
    ]);
    process.exit(0);
  } catch (err) {
    logger.log({
      level: 'error',
      label: 'server',
      message: err.message
    });
    process.exit(1);
  }
};

// Parse SSL path
function parseConf (val) {
  if (!val) return;
  try {
    if (/^-----/.test(val)) {
      return String(val).replace(/\\n/g, '\n');
    } else {
      const data = fs.readFileSync(val, { encoding: 'utf8' });
      fs.watchFile(val, shutdown);
      return data;
    }
  } catch (err) {
    logger.log({
      level: 'error',
      label: 'server',
      message: err.message || err
    });
  }
};

export default async function () {
  try {
  // Process termination
    process.once('SIGTERM', shutdown);
    // Ctrl+C
    process.once('SIGINT', shutdown);
    // Graceful shutdown for nodemon
    process.once('SIGUSR2', shutdown);
    // Connect to DB
    await db.connect();
    // Create web server
    const app = express();
    const protocol = nconf.get('ssl:key') && nconf.get('ssl:cert')
      ? 'https'
      : 'http';
    server = (protocol === 'https')
      ? https.Server(
        {
          key: parseConf(nconf.get('ssl:key')),
          cert: parseConf(nconf.get('ssl:cert')),
          ca: parseConf(nconf.get('ssl:ca'))
        },
        app
      )
      : http.Server(app);
    // Setup app server
    app.enable('trust proxy');
    app.disable('x-powered-by');
    app.use(
      morgan(function (tokens, req, res) {
        const ip = req.ip;
        const method = tokens.method(req, res);
        const url = tokens.url(req, res);
        const statusCode = tokens.status(req, res);
        const statusMessage = res.statusMessage;
        const size = tokens.res(req, res, 'content-length') || 0;
        const duration = ~~tokens['response-time'](req, res);
        const message = `${ip} - ${method} ${url} ${statusCode} (${statusMessage}) ${size} bytes - ${duration} ms`;
        const label = req.protocol;
        let level;
        if (res.statusCode >= 100) {
          level = 'info';
        } else if (res.statusCode >= 400) {
          level = 'warn';
        } else if (res.statusCode >= 500) {
          level = 'error';
        } else {
          level = 'verbose';
        }
        logger.log({ level, label, message });
      })
    );
    app.use(compression());
    app.use(express.urlencoded({ extended: true }));
    app.use(express.json());
    app.use(cors({ origin: true }));
    app.use(cookieParser());
    // Response timeout
    app.use(function (req, res, next) {
      const timeout = nconf.get('http:timeout');
      if (timeout) req.setTimeout(timeout);
      next();
    });
    // Access to session token
    app.use(function (req, res, next) {
      if (req.user) {
        const expires = parseInt(nconf.get('session:expires')) * 60;
        Object.assign(req, 'token', {
          get () {
            const now = ~~(Date.now() / 1000);
            const obj = {
              id: req.user.id,
              exp: now + expires
            };
            return jwt.sign(obj, nconf.get('session:key'));
          }
        });
      }
      next();
    });
    // Routing
    app.use(await setupRoutes());
    // Static
    [nconf.get('static:dir'), PUBLIC_DIR].forEach(function (dir) {
      if (!dir) return;
      app.use(
        express.static(
          dir,
          nconf.get('static:expires')
            ? { maxAge: nconf.get('static:expires') * 60 * 1000 }
            : {}
        )
      );
    });
    // Default router
    app.use(function (req, res, next) {
      res.status(404);
      next();
    });
    // Error handler
    app.use(function (err, req, res, next) {
      // fallback to default node handler
      if (res.headersSent) {
        return next(err);
      }
      // if status not changed
      if (res.statusCode === 200) {
        res.status(500);
      }
      // convert text to error object
      if (typeof err !== 'object') {
        err = new Error(err);
      }
      res.json({ name: err.name, message: err.message, code: res.statusCode });
    });
    // Run server
    server.once('close', function () {
      logger.log({
        level: 'info',
        label: 'server',
        message: 'Listener has been stopped'
      });
    });
    server.on('error', function (err) {
      logger.log({
        level: 'error',
        label: 'server',
        message: err.message || err
      });
    });
    server.listen(nconf.get('port'), nconf.get('host'), function () {
      const address = this.address();
      logger.log({
        level: 'info',
        label: 'server',
        message: `Listening on ${address.address}:${address.port}`
      });
    });
    // HTTP web server
    if (protocol === 'https' && nconf.get('http:port')) {
      httpServer = http.createServer(async function (req, res) {
        // Response timeout
        const timeout = nconf.get('http:timeout');
        if (timeout) req.setTimeout(timeout);
        // ACME HTTP validation (from directory)
        // https://letsencrypt.org/docs/challenge-types/#http-01-challenge
        if (nconf.get('http:webroot') && /^\/\.well-known\/acme-challenge\//.test(req.url)) {
          return fs.readFile(path.join(nconf.get('http:webroot'), req.url), (err, data) => {
            if (err) {
              res.writeHead(404, {
                'Content-Type': 'text/plain'
              }).end('Not Found');
            } else {
              res.writeHead(200, {
                'Content-Length': Buffer.byteLength(data),
                'Content-Type': 'text/plain'
              }).end(data);
            }
          });
        }
        // Redirect from http to https
        const port = nconf.get('port');
        res.writeHead(301, {
          Location: `https://${req.headers.host}${port === '443' ? '' : ':' + port}${req.url}`
        }).end();
      });
      httpServer.listen(nconf.get('http:port'), nconf.get('host'), function () {
        const address = this.address();
        logger.log({
          level: 'info',
          label: 'server',
          message: `HTTP listening on ${address.address}:${address.port}`
        });
      });
    }
    // Lifecycle event
    lifecycle.emit('startup');
  } catch (err) {
    const timeout = parseInt(nconf.get('timeout')) || 0;
    setTimeout(shutdown, timeout * 1000);
  }
}
