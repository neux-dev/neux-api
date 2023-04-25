import config from './config/index.mjs';
import events from './events/index.mjs';
import mongo from './mongo/index.mjs';
import minio from './minio/index.mjs';
import scheduler from './scheduler/index.mjs';
import api from './api/index.mjs';

export default {
  mongo,
  config,
  events,
  scheduler,
  minio,
  api
};
