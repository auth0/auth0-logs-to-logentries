const async = require('async');
const moment = require('moment');
const Logentries = require('logs-to-logentries');

const loggingTools = require('auth0-log-extension-tools');
const config = require('../lib/config');
const logger = require('../lib/logger');

module.exports = (storage) =>
  (req, res, next) => {
    const wtBody = (req.webtaskContext && req.webtaskContext.body) || req.body || {};
    const wtHead = (req.webtaskContext && req.webtaskContext.headers) || {};
    const isCron = (wtBody.schedule && wtBody.state === 'active') || (wtHead.referer === 'https://manage.auth0.com/' && wtHead['if-none-match']);

    if (!isCron) {
      return next();
    }

    // SETUP LOGENTRIES CLIENT
    const logentries = Logentries.createClient({
        url: `https://webhook.logentries.com/noformat/logs/${config('LOGENTRIES_TOKEN')}`
      });

    const onLogsReceived = (logs, callback) => {
      if (!logs || !logs.length) {
        return callback();
      }

      logger.info('Uploading blobs...');

      async.eachLimit(logs, 5, (log, cb) => {
        const date = moment(log.date);
        const url = `${date.format('YYYY/MM/DD')}/${date.format('HH')}/${log._id}.json`;
        logger.info(`Uploading ${url}.`);

        // logentries here...
        logentries.log(JSON.stringify(log), cb);

      }, (err) => {
        if (err) {
          return callback(err);
        }

        logger.info('Upload complete.');
        return callback();
      });
    };

    const slack = new loggingTools.reporters.SlackReporter({
      hook: config('SLACK_INCOMING_WEBHOOK_URL'),
      username: 'auth0-logs-to-logentries',
      title: 'Logs To Logentries'
    });

    const options = {
      domain: config('AUTH0_DOMAIN'),
      clientId: config('AUTH0_CLIENT_ID'),
      clientSecret: config('AUTH0_CLIENT_SECRET'),
      batchSize: config('BATCH_SIZE'),
      startFrom: config('START_FROM'),
      logTypes: config('LOG_TYPES'),
      logLevel: config('LOG_LEVEL')
    };

    const auth0logger = new loggingTools.LogsProcessor(storage, options);

    return auth0logger
      .run(onLogsReceived)
      .then(result => {
        slack.send(result.status, result.checkpoint);
        res.json(result);
      })
      .catch(err => {
        slack.send({ error: err, logsProcessed: 0 }, null);
        next(err);
      });
  };
